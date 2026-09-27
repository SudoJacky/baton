import { afterEach, expect, it, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  configSchema,
  type BoardConfig,
  type Identity,
  type AgentSession,
  type Message,
  type Task,
  type WorkerAssignment,
} from '@baton/shared';
import { ensureLocalAccess, readLocalAccess } from '@baton/shared/local';
import { Board, hashToken } from '../../server/src/board.js';
import { createApp } from '../../server/src/app.js';
import { BoardClient } from '../src/api.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'baton-client-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config: BoardConfig = {
    url: 'http://127.0.0.1:4100',
    agents: {
      planner: { role: 'planner' },
      coder: { role: 'implementer' },
      tester: { role: 'tester' },
    },
    humans: { dax: { display_name: 'Dax' } },
  };
  execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
  const configFile = join(directory, 'agents.yaml');
  const agentToken = await ensureLocalAccess(configFile);
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'baton-client-evidence-'));
  cleanup.push(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const board = new Board({ database: ':memory:', config, agentToken, evidenceDirectory });
  const app = await createApp(board);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(async () => {
    await app.close();
    board.close();
  });
  config.url = address;
  await writeFile(configFile, stringify(config));
  const clients = new Map<string, BoardClient>();
  const client = (handle: string) => {
    if (!clients.has(handle)) {
      const id = config.agents[handle]
        ? board.join(agentToken, { handle }).data.session_id
        : undefined;
      clients.set(handle, new BoardClient(address, id ? agentToken : { human: handle }, id));
    }
    return clients.get(handle)!;
  };
  const cli = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const child = spawn(
      process.execPath,
      [resolve('packages/client/dist/cli.js'), '--config', configFile, ...args],
      {
        windowsHide: true,
        env: {
          ...process.env,
          BOARD_AGENT: '',
          BOARD_TOKEN: '',
          BOARD_SESSION_ID: '',
          BOARD_CONFIG: '',
          ...extraEnv,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, stdout, stderr };
  };
  return { config, client, cli, directory, address, configFile, board, app, agentToken };
}
function processFixture(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    env: {
      ...process.env,
      BOARD_AGENT: '',
      BOARD_TOKEN: '',
      BOARD_SESSION_ID: '',
      BOARD_CONFIG: '',
      ...env,
    },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}
it('runs the planner to tester handoff through real CLI processes with structured arguments', async () => {
  const f = await fixture();
  const file = join(f.directory, 'task.json');
  await writeFile(
    file,
    JSON.stringify({
      title: 'Check the handoff',
      type: 'test',
      role_hint: 'tester',
      acceptance_criteria: ['Evidence attached'],
    }),
  );
  const created = await f.cli(['--as', 'planner', 'task', 'create', '--data-file', file, '--json']);
  expect(created.code, created.stderr).toBe(0);
  const task = JSON.parse(created.stdout).data as Task;
  const claimed = await f.cli(['--as', 'tester', 'task', 'next', '--json']);
  expect(JSON.parse(claimed.stdout).data.id).toBe(task.id);
  const started = await f.cli([
    '--as',
    'tester',
    'task',
    'update',
    String(task.id),
    '--status',
    'in_progress',
    '--json',
  ]);
  expect(started.code, started.stderr).toBe(0);
  const submitFile = join(f.directory, 'submit.json');
  await writeFile(
    submitFile,
    JSON.stringify({
      summary: 'Verified independently',
      reviewer: 'planner',
      artifacts: [{ kind: 'file', ref: '.agent-board/reports/test.txt' }],
    }),
  );
  expect(
    (
      await f.cli([
        '--as',
        'tester',
        'task',
        'submit',
        String(task.id),
        '--data-file',
        submitFile,
        '--json',
      ])
    ).code,
  ).toBe(0);
  await f.client('planner').call('update_task', {
    id: task.id,
    criteria_check: [{ id: task.acceptance_criteria[0]!.id, checked: true }],
  });
  const reviewed = await f.cli([
    '--as',
    'planner',
    'task',
    'review',
    String(task.id),
    '--verdict',
    'approve',
    '--comments',
    'Accepted',
    '--json',
  ]);
  expect(JSON.parse(reviewed.stdout).data.status).toBe('done');
  expect(created.stdout + claimed.stdout + reviewed.stdout).not.toContain(f.agentToken);
});
it('the optional wrapper passes a non-secret session ID and preserves the child exit code', async () => {
  const f = await fixture();
  const script = join(f.directory, 'child.mjs');
  await writeFile(
    script,
    `import { clientFromOptions } from ${JSON.stringify(pathToFileURL(resolve('packages/client/dist/identity.js')).href)}; const {client}=await clientFromOptions({}); const x=await client.call('whoami',{}); console.log(JSON.stringify({handle:x.data.participant.handle,status:x.data.participant.status,session_id:process.env.BOARD_SESSION_ID,has_token:Boolean(process.env.BOARD_TOKEN)})); process.exitCode=7;`,
  );
  const result = await f.cli(['run', '--as', 'tester', '--', process.execPath, script]);
  expect(result.code, result.stderr).toBe(7);
  const data = JSON.parse(result.stdout);
  expect(data).toMatchObject({ handle: 'tester', status: 'online', has_token: false });
  expect(() => f.board.authenticate(f.agentToken, data.session_id)).toThrow();
});

it('shows enum choices and runnable review examples before connecting to a board', async () => {
  const f = await fixture();
  const help = await f.cli(['worker', 'review', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--verdict <approve|changes_requested>');
  expect(help.stdout).toContain('agent-board worker review --run-id');
  expect(help.stdout).toContain('--criteria-passed "[101,102]"');
  expect(
    help.stdout.split('\n').find((line) => line.includes('--verdict changes_requested')),
  ).toContain('--commit-sha "<full-sha>"');
  expect(help.stdout).toContain('agent-board worker evidence');
  expect((await f.cli(['task', 'dispatch', '--help'])).stdout).toContain(
    '--mode <implement|review>',
  );
  const invalid = await f.cli([
    '--url',
    'http://127.0.0.1:1',
    'worker',
    'review',
    '--verdict',
    'approved',
  ]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('Allowed choices are approve, changes_requested');
});

it('returns runnable handoff commands and captures isolated evidence while reporting CLI lease limits', async () => {
  const f = await fixture();
  const task = (
    await f.client('dax').call<Task>('create_task', { title: 'Evidence helper', type: 'test' })
  ).data;
  const dispatched = await f.cli([
    '--session',
    f.client('planner').sessionId!,
    'task',
    'dispatch',
    String(task.id),
    '--handle',
    'coder',
    '--mode',
    'implement',
    '--json',
  ]);
  expect(dispatched.code, dispatched.stderr).toBe(0);
  const run = JSON.parse(dispatched.stdout).data as WorkerAssignment & {
    integration: {
      worker_get: { argv: string[]; command: string };
      lease: { managed_here: boolean };
    };
  };
  expect(run.integration.lease.managed_here).toBe(false);
  const get = await f.cli(run.integration.worker_get.argv.slice(2));
  expect(get.code, get.stderr).toBe(0);
  expect(JSON.parse(get.stdout).data.run_id).toBe(run.run_id);
  const doctor = await f.cli(['doctor', '--run-id', run.run_id, '--json']);
  expect(doctor.code).toBe(1);
  expect(JSON.parse(doctor.stdout).data.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'identity',
        status: 'ok',
        detail: expect.objectContaining({ handle: 'coder' }),
      }),
      expect.objectContaining({ name: 'lease', status: 'attention' }),
    ]),
  );
  const check = await f.cli([
    '--json',
    'evidence',
    '--output-dir',
    run.evidence_directory,
    '--scope',
    'Command failure only; no UI coverage',
    '--',
    process.execPath,
    '-e',
    'console.log("check output"); process.exitCode=7;',
  ]);
  expect(check.code, check.stderr).toBe(7);
  const capture = JSON.parse(check.stdout);
  expect(capture.evidence[0]).toMatchObject({
    exit_code: 7,
    scope: 'Command failure only; no UI coverage',
  });
  expect(await readFile(capture.evidence[0].path, 'utf8')).toContain('check output');
  const secondCheck = await f.cli([
    '--json',
    'evidence',
    '--output-dir',
    run.evidence_directory,
    '--scope',
    'Second independent check',
    '--',
    process.execPath,
    '-e',
    'console.log("second check");',
  ]);
  expect(secondCheck.code, secondCheck.stderr).toBe(0);
  const preview = await f.cli(['worker', 'evidence', '--run-id', run.run_id, '--json']);
  expect(preview.code, preview.stderr).toBe(0);
  const manifest = JSON.parse(preview.stdout).data;
  expect(manifest.evidence).toHaveLength(2);
  expect(manifest.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ exit_code: 7, scope: capture.evidence[0].scope }),
    ]),
  );
  const submission = join(f.directory, 'evidence-submit.json');
  await writeFile(
    submission,
    JSON.stringify({
      summary: 'Captured a failing command for independent review',
      evidence_manifest: manifest.evidence_manifest,
    }),
  );
  const accepted = await f.cli([
    'worker',
    'submit',
    '--run-id',
    run.run_id,
    '--data-file',
    submission,
    '--json',
  ]);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout).data.evidence).toHaveLength(2);
  expect(JSON.parse(accepted.stdout).data.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        run_id: run.run_id,
        exit_code: 7,
        sha256: expect.any(String),
      }),
    ]),
  );
  const restored = await f.cli(['--session', f.client('planner').sessionId!, 'doctor', '--json']);
  expect(restored.code, restored.stderr).toBe(0);
  expect(JSON.parse(restored.stdout).data.pending).toContainEqual(
    expect.objectContaining({
      task_id: task.id,
      handoff: expect.objectContaining({
        next_action: expect.objectContaining({ action: 'dispatch_review' }),
      }),
    }),
  );
  expect(dispatched.stdout + doctor.stdout + restored.stdout).not.toContain(f.agentToken);
});
async function connectMcp(
  f: Awaited<ReturnType<typeof fixture>>,
  profile: 'full' | 'workflow' = 'full',
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/client/dist/mcp.js'), '--config', f.configFile, '--profile', profile],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (p): p is [string, string] => typeof p[1] === 'string' && !p[0].startsWith('BOARD_'),
        ),
      ),
      // Even a mistakenly inherited human token must never become MCP authority.
      BOARD_TOKEN: 'human-test-token-'.repeat(3),
      BOARD_AGENT: 'dax',
    },
    stderr: 'pipe',
  });
  const mcp = new Client({ name: 'baton-integration-test', version: '0.1.0' });
  cleanup.push(() => mcp.close());
  await mcp.connect(transport);
  return mcp;
}
function toolData(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content as { type: string; text: string }[])[0]!.text).data;
}
it('runs the four worker tools over one shared MCP with automatic leases and real Git review', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, '.gitignore'), ' *\n!.gitignore\n!code.ts\n'.trimStart());
  await writeFile(join(f.directory, 'code.ts'), 'export const answer = 42;\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.directory, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git('add', '--', '.gitignore', 'code.ts');
  git(
    '-c',
    'user.name=Baton Test',
    '-c',
    'user.email=baton@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Test implementation',
  );
  const sha = git('rev-parse', 'HEAD');
  const mcp = await connectMcp(f, 'workflow');
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'get_task',
      'post_message',
      'prepare_evidence',
      'submit',
      'review',
      'dispatch_task',
    ]),
  );
  for (const name of [
    'claim_task',
    'update_task',
    'review_task',
    'submit_for_review',
    'mark_read',
    'worker_heartbeat',
  ])
    expect(names).not.toContain(name);
  const call = async (name: string, args: Record<string, unknown>) =>
    toolData(await mcp.callTool({ name, arguments: args }));
  const planner = (await call('join', { handle: 'planner' })) as AgentSession;
  const parent = (await call('create_task', {
    session_id: planner.session_id,
    title: 'MCP plan',
    type: 'plan',
  })) as Task;
  const task = (await call('create_task', {
    session_id: planner.session_id,
    title: 'MCP implementation',
    type: 'implement',
    parent_id: parent.id,
    repository: f.directory,
    acceptance_criteria: ['Exports 42'],
  })) as Task;
  await call('request_approval', {
    session_id: planner.session_id,
    id: parent.id,
    to_status: 'open',
    reason: 'Discussed plan',
  });
  await f
    .client('dax')
    .call('transition_task', { id: parent.id, status: 'open', reason: 'Approved' });
  await f.client('dax').call('put_settings', { lease_minutes: 0.03 });
  const worker = (await call('dispatch_task', {
    session_id: planner.session_id,
    id: task.id,
    mode: 'implement',
    handle: 'coder',
  })) as WorkerAssignment;
  expect(await call('doctor', { run_id: worker.run_id })).toMatchObject({
    ready: true,
    checks: expect.arrayContaining([
      expect.objectContaining({
        name: 'lease',
        status: 'ok',
        detail: expect.objectContaining({ managed_here: true }),
      }),
    ]),
  });
  const inspectionOnly = await connectMcp(f, 'workflow');
  expect(
    toolData(
      await inspectionOnly.callTool({ name: 'doctor', arguments: { run_id: worker.run_id } }),
    ),
  ).toMatchObject({
    ready: false,
    checks: expect.arrayContaining([
      expect.objectContaining({
        name: 'lease',
        status: 'attention',
        detail: expect.objectContaining({ managed_here: false }),
      }),
    ]),
  });
  const events = f.board.eventCursor();
  const until = Date.now() + 3700;
  while (Date.now() < until) {
    await call('get_task', { run_id: worker.run_id });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const live = (await call('get_task', { run_id: worker.run_id })) as WorkerAssignment;
  expect(live.task).toMatchObject({ status: 'in_progress', lease_expired_at: null });
  expect(f.board.eventCursor()).toBe(events);
  const health = (await call('doctor', { run_id: worker.run_id })) as {
    checks: { name: string; detail: { last_success_at?: string } }[];
  };
  expect(health.checks.find((c) => c.name === 'lease')!.detail.last_success_at).toEqual(
    expect.any(String),
  );
  await call('post_message', { run_id: worker.run_id, body: 'Implementation and checks complete' });
  expect(
    (
      (await call('submit', {
        run_id: worker.run_id,
        summary: 'Exports 42',
        commit_sha: sha,
      })) as WorkerAssignment
    ).task.status,
  ).toBe('in_review');
  const reviewer = (await call('dispatch_task', {
    session_id: planner.session_id,
    id: task.id,
    mode: 'review',
    handle: 'tester',
  })) as WorkerAssignment;
  const source = await readFile(join(f.directory, 'code.ts'), 'utf8');
  expect(source).toContain('answer = 42');
  // The four-tool facade must still enforce the fixed reviewed revision and clean working tree.
  await writeFile(join(f.directory, 'code.ts'), 'export const answer = 0;\n');
  const dirty = await mcp.callTool({
    name: 'review',
    arguments: {
      run_id: reviewer.run_id,
      verdict: 'approve',
      comments: 'No stale approval',
      commit_sha: sha,
      criteria_passed: reviewer.task.acceptance_criteria.map((c) => c.id),
    },
  });
  expect(dirty.isError).toBe(true);
  expect(JSON.stringify(dirty.content)).toContain('dirty_worktree');
  await writeFile(join(f.directory, 'code.ts'), source);
  await writeFile(
    join(reviewer.evidence_directory, 'independent-review.txt'),
    'Read code.ts and verified answer = 42',
  );
  const prepared = (await call('prepare_evidence', {
    run_id: reviewer.run_id,
    evidence: [{ path: 'independent-review.txt', scope: 'Source inspection and fixed HEAD check' }],
  })) as { evidence_manifest: string };
  const reviewed = (await call('review', {
    run_id: reviewer.run_id,
    verdict: 'approve',
    comments: 'Read code.ts; export is 42; HEAD and clean status verified',
    commit_sha: sha,
    criteria_passed: reviewer.task.acceptance_criteria.map((c) => c.id),
    evidence_manifest: prepared.evidence_manifest,
  })) as WorkerAssignment;
  expect(reviewed.task.status).toBe('done');
  expect(reviewed.evidence[0]).toMatchObject({
    run_id: reviewer.run_id,
    commit_sha: sha,
    sha256: expect.any(String),
  });
  expect((await f.client('dax').call<unknown[]>('list_approvals', {})).data).toHaveLength(0);
  expect(
    (
      (await call('complete_plan', {
        session_id: planner.session_id,
        id: parent.id,
        summary: 'Implementation independently checked',
      })) as Task
    ).status,
  ).toBe('done');
}, 20000);
it('keeps three conversations independent through one shared MCP without any per-agent credentials', async () => {
  const f = await fixture();
  const mcp = await connectMcp(f);
  const catalog = (await mcp.listTools()).tools;
  const tools = catalog.map((t) => t.name);
  expect(
    Object.keys(catalog.find((t) => t.name === 'join')!.inputSchema.properties ?? {}).sort(),
  ).toEqual(['handle', 'role']);
  expect(tools).toContain('join');
  expect(tools).toContain('request_approval');
  for (const name of [
    'acquire_lock',
    'release_lock',
    'transition_task',
    'put_settings',
    'update_profile',
    'freeze_participant',
    'reject_approval',
  ])
    expect(tools).not.toContain(name);
  const joined = await Promise.all(
    ['planner', 'coder', 'tester'].map(
      async (handle) =>
        toolData(await mcp.callTool({ name: 'join', arguments: { handle } })) as AgentSession,
    ),
  );
  expect(new Set(joined.map((s) => s.session_id)).size).toBe(3);
  await Promise.all(
    joined.map((s) =>
      mcp.callTool({
        name: 'post_message',
        arguments: {
          session_id: s.session_id,
          channel: 'general',
          body: `Message from ${s.participant.handle}`,
        },
      }),
    ),
  );
  const messages = (await f.client('dax').call<Message[]>('get_thread', { channel: 'general' }))
    .data;
  expect(messages).toHaveLength(3);
  for (const msg of messages) expect(msg.body).toBe(`Message from ${msg.author}`);
  const identities = await Promise.all(
    joined.map((s) => mcp.callTool({ name: 'whoami', arguments: { session_id: s.session_id } })),
  );
  expect(identities.map((r) => toolData(r).participant.handle)).toEqual([
    'planner',
    'coder',
    'tester',
  ]);
  expect((await mcp.callTool({ name: 'whoami', arguments: {} })).isError).toBe(true);
  expect(
    (await mcp.callTool({ name: 'join', arguments: { handle: 'dax', role: 'planner' } })).isError,
  ).toBe(true);
  const ended = joined[1]!.session_id;
  toolData(await mcp.callTool({ name: 'leave', arguments: { session_id: ended } }));
  expect((await mcp.callTool({ name: 'whoami', arguments: { session_id: ended } })).isError).toBe(
    true,
  );
  expect(
    toolData(
      await mcp.callTool({ name: 'whoami', arguments: { session_id: joined[2]!.session_id } }),
    ).participant.handle,
  ).toBe('tester');
  expect(JSON.stringify(messages)).not.toContain(f.agentToken);
});
it('resumes the same session after MCP restarts and does not treat an idle MCP as agent activity', async () => {
  const f = await fixture();
  const first = await connectMcp(f);
  const session = toolData(
    await first.callTool({ name: 'join', arguments: { handle: 'coder' } }),
  ).session_id;
  const old = new Date(Date.now() - 100000).toISOString();
  f.board.store.run('UPDATE sessions SET last_seen_at=? WHERE id=?', old, session);
  f.board.store.run('UPDATE participants SET last_seen_at=? WHERE handle=?', old, 'coder');
  f.board.sweep();
  expect((await f.client('dax').call<Identity>('get_overview', {})).data).toHaveProperty(
    'participants',
  );
  expect(
    f.board.store.get<{ status: string }>(
      'SELECT status FROM participants WHERE handle=?',
      'coder',
    )!.status,
  ).toBe('offline');
  await first.close();
  const second = await connectMcp(f);
  expect(
    toolData(await second.callTool({ name: 'whoami', arguments: { session_id: session } }))
      .participant.handle,
  ).toBe('coder');
});
it('init creates local profiles without human credentials and refuses overwrite', async () => {
  const f = await fixture();
  const file = join(f.directory, 'new-config.yaml');
  const result = await f.cli(['--config', file, 'init', '--json']);
  expect(result.code, result.stderr).toBe(0);
  const before = await readFile(file, 'utf8');
  expect(before).not.toContain('token');
  expect(await readLocalAccess(file)).toHaveLength(43);
  expect(JSON.parse(result.stdout)).toMatchObject({ human: 'dax', config: file });
  expect(result.stdout).not.toMatch(/login_code|token/);
  expect(configSchema.parse(parse(before)).humans.dax).toEqual({});
  expect((await f.cli(['--config', file, 'init', '--json'])).code).toBe(1);
  expect(await readFile(file, 'utf8')).toBe(before);
});
it('uses the local human in the dashboard client, CLI and event stream without a credential', async () => {
  const f = await fixture();
  const dashboard = new BoardClient(f.address);
  expect((await dashboard.call<Identity>('whoami', {})).data.participant).toMatchObject({
    handle: 'dax',
    kind: 'human',
  });
  const result = await f.cli(['--as', 'dax', 'whoami', '--json']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).data.participant.handle).toBe('dax');
  expect((await f.cli(['--as', 'dax', 'whoami', '--json'], { BOARD_AGENT: 'dax' })).code).toBe(1);
  const controller = new AbortController();
  const received: string[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const streaming = dashboard.stream(
    f.board.eventCursor(),
    (event) => {
      received.push(event.type);
    },
    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    connected,
  );
  // Observe failures immediately while waiting for the stream to connect.
  const stopped = streaming.catch((error) => {
    if (!controller.signal.aborted) throw error;
  });
  try {
    await Promise.race([ready, stopped]);
    await dashboard.call('acquire_lock', {
      repository: f.directory,
      reason: 'Local human operation',
    });
    await vi.waitFor(() => expect(received).toContain('lock.acquired'));
  } finally {
    controller.abort();
    await stopped;
  }
});
it('loads old human credentials without requiring migration or accepting them as authority', async () => {
  const f = await fixture();
  const oldLogin = 'legacy-human-token-'.repeat(3);
  for (const human of [{ token: oldLogin }, { token_hash: hashToken(oldLogin) }]) {
    const legacy = { ...f.config, humans: { dax: { ...human, display_name: 'Local Dax' } } };
    await writeFile(f.configFile, stringify(legacy));
    const result = await f.cli(['--as', 'dax', 'whoami', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const migrated = configSchema.parse(legacy);
    expect(migrated.humans.dax).toEqual({ display_name: 'Local Dax' });
    const board = new Board({
      database: ':memory:',
      config: migrated,
      agentToken: f.agentToken,
    });
    try {
      expect(board.localHuman().kind).toBe('human');
      expect(() => board.authenticate(oldLogin)).toThrow();
      expect(() => board.authenticate(hashToken(oldLogin))).toThrow();
    } finally {
      board.close();
    }
  }
});
it('removes obsolete credentials and tool metadata without rotating the automatic local key', async () => {
  const f = await fixture();
  const oldLogin = 'previous-human-login-'.repeat(3);
  const oldAgent = 'previous-agent-token-'.repeat(3);
  await writeFile(
    f.configFile,
    stringify({
      ...f.config,
      agents: {
        ...f.config.agents,
        coder: { ...f.config.agents.coder, token: oldAgent, runtime: 'claude-code', model: 'opus' },
      },
      humans: {
        dax: {
          token: oldLogin,
          token_hash: hashToken(oldLogin),
          runtime: 'browser',
          model: 'unused',
        },
      },
    }),
  );
  for (let i = 0; i < 2; i++) {
    const result = await f.cli(['migrate', '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(oldLogin);
    expect(result.stdout).not.toContain(oldAgent);
  }
  const raw = await readFile(f.configFile, 'utf8');
  expect(raw).not.toContain('token');
  expect(raw).not.toMatch(/runtime:|model:/);
  expect(configSchema.parse(parse(raw)).agents).toEqual(f.config.agents);
  expect(configSchema.parse(parse(raw)).humans.dax).toEqual({});
  expect(await readLocalAccess(f.configFile)).toBe(f.agentToken);
});
it('uses an explicit CLI session across commands and refuses accidental identity changes', async () => {
  const f = await fixture();
  const joined = await f.cli(['join', '--handle', 'app_coder', '--role', 'implementer', '--json']);
  expect(joined.code, joined.stderr).toBe(0);
  const session = JSON.parse(joined.stdout).data.session_id;
  const who = await f.cli(['--session', session, 'whoami', '--json']);
  expect(who.code, who.stderr).toBe(0);
  expect(JSON.parse(who.stdout).data.participant.handle).toBe('app_coder');
  expect((await f.cli(['--session', session, '--as', 'tester', 'whoami', '--json'])).code).toBe(1);
  expect(
    (
      await f.cli(['--session', session, '--as', 'dax', 'whoami', '--json'], {
        BOARD_TOKEN: 'human-test-token-'.repeat(3),
      })
    ).code,
  ).toBe(1);
  expect((await f.cli(['--session', session, 'leave', '--json'])).code).toBe(0);
  expect((await f.cli(['--session', session, 'whoami', '--json'])).code).toBe(1);
});
it('watch reconnects after a real server restart without replaying mentions already delivered', async () => {
  const f = await fixture();
  const watch = processFixture([
    resolve('packages/client/dist/cli.js'),
    '--config',
    f.configFile,
    '--as',
    'coder',
    'watch',
  ]);
  await f.client('planner').call('post_message', { to: 'coder', body: 'before restart' });
  await vi.waitFor(() => expect(watch.output().stdout).toContain('before restart'), {
    timeout: 5000,
  });
  await f.app.close();
  await vi.waitFor(() => expect(watch.output().stderr).toContain('retrying'), { timeout: 5000 });
  expect(watch.child.exitCode).toBeNull();
  const restarted = await createApp(f.board);
  cleanup.push(() => restarted.close());
  await restarted.listen({ host: '127.0.0.1', port: Number(new URL(f.address).port) });
  await f.client('planner').call('post_message', { to: 'coder', body: 'after restart' });
  await vi.waitFor(() => expect(watch.output().stdout).toContain('after restart'), {
    timeout: 5000,
  });
  expect(
    watch
      .output()
      .stdout.trim()
      .split('\n')
      .map((line) => JSON.parse(line).message.body),
  ).toEqual(['before restart', 'after restart']);
  watch.child.kill();
  await watch.exited;
}, 15000);
it('closes the MCP process when stdin ends without creating an implicit participant', async () => {
  const f = await fixture();
  const mcp = processFixture([resolve('packages/client/dist/mcp.js'), '--config', f.configFile]);
  mcp.child.stdin.end();
  expect(await mcp.exited).toBe(0);
  expect(f.board.store.get<{ n: number }>('SELECT count(*) n FROM sessions')!.n).toBe(0);
}, 10000);
it('preserves the child exit code when the server is unavailable during cleanup', async () => {
  const f = await fixture();
  const script = join(f.directory, 'exit-on-input.mjs');
  await writeFile(
    script,
    "process.stdout.write('CHILD_READY\\n'); process.stdin.once('data', () => process.exit(7)); process.stdin.resume();\n",
  );
  const wrapper = processFixture([
    resolve('packages/client/dist/cli.js'),
    '--config',
    f.configFile,
    '--as',
    'coder',
    'run',
    '--',
    process.execPath,
    script,
  ]);
  await vi.waitFor(() => expect(wrapper.output().stdout).toContain('CHILD_READY'), {
    timeout: 5000,
  });
  await f.app.close();
  wrapper.child.stdin.write('exit\n');
  expect(await wrapper.exited).toBe(7);
  expect(wrapper.output().stderr).toContain('session cleanup failed');
}, 10000);
it('selects a repository per MCP call and exposes the same selection in CLI filters and locks', async () => {
  const f = await fixture();
  const other = join(f.directory, 'other');
  execFileSync('git', ['init', '--quiet', other], { windowsHide: true });
  const mcp = await connectMcp(f);
  const session = toolData(
    await mcp.callTool({ name: 'join', arguments: { handle: 'planner' } }),
  ) as AgentSession;
  const created: Task[] = [];
  for (const repository of [f.directory, other]) {
    const task = toolData(
      await mcp.callTool({
        name: 'create_task',
        arguments: {
          session_id: session.session_id,
          title: `Work in ${repository}`,
          type: 'test',
          repository,
        },
      }),
    ) as Task;
    expect(task.repository).toBeTruthy();
    created.push(task);
  }
  expect(created[0]!.repository).not.toBe(created[1]!.repository);
  const listed = await f.cli(['--as', 'dax', 'task', 'list', '--repository', other, '--json']);
  expect(listed.code, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).data.map((t: Task) => t.id)).toEqual([created[1]!.id]);
  const lock = await f.cli(['--as', 'dax', 'lock', 'show', '--repository', other, '--json']);
  expect(lock.code, lock.stderr).toBe(0);
  expect(JSON.parse(lock.stdout).data).toMatchObject({
    repository: created[1]!.repository,
    holder: null,
  });
  const legacy = await f.cli(['--as', 'dax', 'lock', 'show', '--repository', 'null', '--json']);
  expect(legacy.code, legacy.stderr).toBe(0);
  expect(JSON.parse(legacy.stdout).data.repository).toBeNull();
});

it('the unattended tester runs an immutable commit and submits a report without approving itself', async () => {
  const f = await fixture();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.directory, ...args], { encoding: 'utf8', windowsHide: true });
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Baton Test');
  await writeFile(join(f.directory, 'verify.mjs'), 'console.log("immutable fixture passed");\n');
  git('add', 'verify.mjs');
  git('commit', '-m', 'Add immutable test fixture');
  const sha = git('rev-parse', 'HEAD').trim();
  // The dirty shared workspace deliberately differs; the test worker must use the commit.
  await writeFile(join(f.directory, 'verify.mjs'), 'throw new Error("Wrong working tree");\n');
  const dirtyBefore = git('status', '--porcelain', '--untracked-files=all');
  const reportsDirectory = await mkdtemp(join(tmpdir(), 'baton-reports-'));
  cleanup.push(() => rm(reportsDirectory, { recursive: true, force: true }));
  const task = (
    await f.client('planner').call<Task>('create_task', {
      title: 'Pinned test',
      repository: f.directory,
      type: 'test',
      role_hint: 'tester',
      acceptance_criteria: ['Independent reviewer reads report'],
    })
  ).data;
  await f
    .client('dax')
    .call('update_task', { id: task.id, artifacts_add: [{ kind: 'commit', ref: sha }] });
  const result = await f.cli([
    'run',
    '--as',
    'tester',
    '--',
    process.execPath,
    resolve('templates/readonly-tester.ts'),
    '--reports',
    reportsDirectory,
    '--once',
    '--',
    process.execPath,
    'verify.mjs',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const complete = (await f.client('planner').call<Task>('get_task', { id: task.id })).data;
  expect(complete.status).toBe('in_review');
  expect(complete.acceptance_criteria[0]!.checked).toBe(false);
  const report = complete.artifacts.find((a) => a.kind === 'file')!;
  expect(await readFile(report.ref, 'utf8')).toContain('immutable fixture passed');
  expect(report.ref.startsWith(reportsDirectory)).toBe(true);
  expect(git('status', '--porcelain', '--untracked-files=all')).toBe(dirtyBefore);
  expect(await readFile(join(f.directory, 'verify.mjs'), 'utf8')).toContain('Wrong working tree');
});
