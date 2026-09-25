/** An opt-in, deterministic tester. The human supplies a trusted command at launch. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Task, Mention, Settings } from '../packages/shared/dist/index.js';
import { ApiError } from '../packages/client/dist/api.js';
import { clientFromOptions } from '../packages/client/dist/identity.js';

const divider = process.argv.indexOf('--');
const options = divider < 0 ? process.argv.slice(2) : process.argv.slice(2, divider);
const command = divider < 0 ? [] : process.argv.slice(divider + 1);
const { values } = parseArgs({
  args: options,
  options: { once: { type: 'boolean' }, reports: { type: 'string' } },
});
if (!command.length)
  throw new Error(
    'Usage: agent-board run --as tester -- node templates/readonly-tester.ts [--once] -- <trusted-test-command> [args...]',
  );
function reportsFor(repository: string): string {
  const reportsDirectory = resolve(
    values.reports ??
      join(
        homedir(),
        '.agent-board',
        'reports',
        createHash('sha256').update(repository).digest('hex').slice(0, 16),
      ),
  );
  const reportsRelative = relative(repository, reportsDirectory);
  if (
    !reportsRelative ||
    (!isAbsolute(reportsRelative) &&
      reportsRelative !== '..' &&
      !reportsRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
    throw new Error(
      '--reports must be outside the target repository so reports cannot dirty its working tree.',
    );
  return reportsDirectory;
}
if (!process.env.BOARD_SESSION_ID)
  throw new Error(
    'Start this worker with agent-board run, or provide its existing BOARD_SESSION_ID.',
  );
const { client } = await clientFromOptions({});
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
process.once('SIGHUP', () => stop.abort());
let cursor = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
while (!stop.signal.aborted) {
  let task: Task;
  try {
    task = (await client.call<Task>('claim_next', { role_hint: 'tester' }, stop.signal)).data;
  } catch (error) {
    if (stop.signal.aborted) break;
    if (!(error instanceof ApiError) || error.code !== 'no_eligible_task') throw error;
    if (values.once) break;
    let inbox: Mention[];
    try {
      inbox = (
        await client.call<Mention[]>('wait_inbox', { timeout: 15, since: cursor }, stop.signal)
      ).data;
    } catch (waitError) {
      if (stop.signal.aborted) break;
      throw waitError;
    }
    if (inbox.length) cursor = inbox.at(-1)!.id;
    continue;
  }
  let checkout: string | undefined;
  let renew: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | undefined;
  let leaseError: unknown;
  try {
    if (task.type !== 'test' || task.writes_code)
      throw new Error('This worker only handles read-only test tasks.');
    if (!task.repository)
      throw new Error('Choose a repository on this test task before running it.');
    const repository = task.repository;
    const reportsDirectory = reportsFor(repository);
    const dependencies = await Promise.all(
      task.depends_on.map(async (id) => (await client.call<Task>('get_task', { id })).data),
    );
    const sha =
      task.artifacts.find((a) => a.kind === 'commit')?.ref ??
      dependencies
        .filter((t) => t.repository === repository)
        .flatMap((t) => t.artifacts)
        .filter((a) => a.kind === 'commit')
        .at(-1)?.ref;
    if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))
      throw new Error('Attach a full commit SHA to this task or to a completed dependency.');
    git(repository, 'rev-parse', '--verify', `${sha}^{commit}`);
    await client.call('update_task', {
      id: task.id,
      status: 'in_progress',
      note: `Testing immutable commit ${sha}.`,
    });
    // A fresh local clone pins the test input even if the shared repository's next writer starts.
    checkout = await mkdtemp(join(tmpdir(), 'baton-test-'));
    git(
      repository,
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-hardlinks',
      '--',
      repository,
      checkout,
    );
    git(checkout, 'checkout', '--quiet', '--detach', sha);
    const testEnv = { ...process.env };
    delete testEnv.BOARD_TOKEN;
    delete testEnv.BOARD_SESSION_ID;
    let report = `Task: T-${task.id}\nRepository: ${repository}\nCommit: ${sha}\nCommand: ${JSON.stringify(command)}\n\n`;
    let outputSize = 0;
    const policy = (await client.call<Settings>('get_settings', {})).data;
    const child = spawn(command[0]!, command.slice(1), {
      cwd: checkout,
      env: testEnv,
      shell: false,
      windowsHide: true,
      signal: stop.signal,
    });
    renew = setInterval(
      () => {
        if (renewal) return;
        renewal = client
          .call('update_task', { id: task.id })
          .then(() => {})
          .catch((error) => {
            leaseError = error;
            child.kill();
          })
          .finally(() => {
            renewal = undefined;
          });
      },
      Math.max(500, (policy.lease_minutes * 60000) / 3),
    );
    const append = (data: Buffer) => {
      outputSize += data.length;
      if (outputSize > 2 * 1024 * 1024) {
        leaseError = new Error('Test output exceeded the 2 MiB report limit.');
        child.kill();
        return;
      }
      report += data.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    clearInterval(renew);
    await renewal;
    if (leaseError) throw leaseError;
    if (stop.signal.aborted) throw new Error('The test worker was stopped.');
    report += `\nExit code: ${code}\n`;
    const reportPath = resolve(reportsDirectory, `T-${task.id}-${Date.now()}.txt`);
    await mkdir(reportsDirectory, { recursive: true });
    await writeFile(reportPath, report);
    await client.call('post_message', {
      task_id: task.id,
      kind: 'report',
      body: `Commit ${sha}: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code}). Report: ${reportPath}`,
      mentions: [task.creator],
    });
    if (code !== 0) throw new Error(`Tests failed with exit ${code}; inspect ${reportPath}.`);
    // Do not tick semantic acceptance criteria automatically; an independent reviewer still verifies them.
    await client.call('submit_for_review', {
      id: task.id,
      summary: `Tests passed against commit ${sha}. Review the attached report and acceptance criteria.`,
      artifacts: [
        { kind: 'commit', ref: sha },
        { kind: 'file', ref: reportPath },
      ],
    });
    console.log(
      JSON.stringify({ task_id: task.id, commit: sha, report: reportPath, status: 'in_review' }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`T-${task.id}: ${message}`);
    try {
      await client.call('update_task', {
        id: task.id,
        status: 'blocked',
        note: `@human Test worker stopped: ${message}`,
      });
    } catch (reportError) {
      console.error(
        'Could not update the task:',
        reportError instanceof Error ? reportError.message : String(reportError),
      );
    }
    if (values.once) process.exitCode = 1;
  } finally {
    clearInterval(renew);
    await renewal;
    if (checkout) {
      const path = resolve(checkout);
      const inside = relative(resolve(tmpdir()), path);
      if (inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('baton-test-'))
        throw new Error('Refusing to remove an unexpected checkout path.');
      await rm(path, { recursive: true, force: true });
    }
  }
  if (values.once) break;
}
