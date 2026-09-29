import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BoardClient } from '../src/api.js';
import { loadStartupConfig } from '../../server/src/startup.js';

// The same checks can target an independently installed npm tarball.
const launcher = resolve(process.env.BATON_LAUNCHER_PATH ?? 'packages/client/dist/launcher.js');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'baton 新用户 '));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const inherited = { ...process.env };
  delete inherited.BOARD_CONFIG;
  delete inherited.BOARD_PORT;
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd,
    windowsHide: true,
    env: { ...inherited, ...env },
  });
  let stdout = '';
  let stderr = '';
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  cleanup.push(stop);
  return {
    stop,
    result: async () => ({ code: await exited, stdout, stderr }),
    started: () =>
      new Promise<string>((resolve, reject) => {
        const inspect = () => {
          const address = stdout.match(/Baton dashboard: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (address) {
            child.stdout.off('data', inspect);
            resolve(address);
          }
        };
        child.stdout.on('data', inspect);
        inspect();
        void exited.then(
          () => reject(new Error(`Baton exited before listening: ${stderr}`)),
          reject,
        );
      }),
  };
}

it('starts from an empty directory, serves the dashboard, connects MCP and preserves tasks and sessions on restart', async () => {
  const cwd = await directory();
  const config = join(cwd, 'state', 'agents.yaml');
  const port = await unusedPort();
  const env = { BOARD_PORT: String(port) };
  const first = run(['--config', config, '--no-open'], cwd, env);
  const address = await first.started();
  const originalConfig = await readFile(config, 'utf8');
  const access = await readFile(`${config}.access.json`, 'utf8');
  expect(parse(originalConfig).url).toBe(address);
  const page = await fetch(address);
  const html = await page.text();
  expect(page.status).toBe(200);
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  expect(asset).toBeTruthy();
  expect((await fetch(new URL(asset!, address))).status).toBe(200);

  const human = new BoardClient(address, { human: 'dax' });
  const task = await human.call<{ id: number }>('create_task', {
    title: 'Keep this task',
    type: 'plan',
  });
  const mcp = new Client({ name: 'fresh-install-test', version: '1' });
  const guide = await run(['setup', '--host', 'claude-code', '--config', config], cwd).result();
  expect(guide.code, guide.stderr).toBe(0);
  const settings = JSON.parse(
    guide.stdout.slice(guide.stdout.indexOf('{'), guide.stdout.lastIndexOf('}') + 1),
  );
  await mcp.connect(
    new StdioClientTransport({
      ...settings.mcpServers.agent_board,
      cwd: process.env.BATON_NPM_TEST_CWD ?? cwd,
      env: { ...process.env, npm_config_offline: 'true' } as Record<string, string>,
      stderr: 'pipe',
    }),
  );
  cleanup.push(() => mcp.close());
  const joined = await mcp.callTool({ name: 'join', arguments: { handle: 'planner' } });
  const text = (joined.content as { type: string; text: string }[])[0]!.text;
  const session = JSON.parse(text).data.session_id as string;
  const checked = await mcp.callTool({ name: 'doctor', arguments: { session_id: session } });
  expect(checked.isError).not.toBe(true);
  expect(JSON.parse((checked.content as { text: string }[])[0]!.text).data.ready).toBe(true);
  await mcp.close();
  await first.stop();
  const second = run(['start', '--config', config, '--no-open'], cwd, env);
  expect(await second.started()).toBe(address);
  expect(await readFile(config, 'utf8')).toBe(originalConfig);
  expect(await readFile(`${config}.access.json`, 'utf8')).toBe(access);
  expect((await human.call<{ title: string }>('get_task', { id: task.data.id })).data.title).toBe(
    'Keep this task',
  );
  const token = JSON.parse(access).token as string;
  expect(
    (
      await new BoardClient(address, token, session).call<{ participant: { handle: string } }>(
        'whoami',
        {},
      )
    ).data.participant.handle,
  ).toBe('planner');
  await second.stop();
  const logs = await first.result();
  expect(logs.stdout).toContain('[mcp_servers.agent_board]');
  expect(logs.stdout + logs.stderr).not.toContain(token);
});

it('does not replace invalid configuration or overwrite a customized skill', async () => {
  const cwd = await directory();
  const config = join(cwd, 'invalid.yaml');
  await writeFile(config, 'not: [valid');
  const result = await run(['--config', config, '--no-open'], cwd, { BOARD_PORT: '4100' }).result();
  expect(result.code).toBe(1);
  expect(await readFile(config, 'utf8')).toBe('not: [valid');

  const codex = join(cwd, 'codex home');
  const installed = await run(['install-skill'], cwd, { CODEX_HOME: codex }).result();
  expect(installed.code, installed.stderr).toBe(0);
  const skill = join(codex, 'skills/baton/SKILL.md');
  expect(await readFile(skill, 'utf8')).toContain('Baton');
  expect(await readFile(join(codex, 'skills/baton/references/orchestration.md'), 'utf8')).toContain(
    'run_id',
  );
  await writeFile(skill, 'Customized skill');
  const repeat = await run(['install-skill'], cwd, { CODEX_HOME: codex }).result();
  expect(repeat.code).toBe(1);
  expect(repeat.stderr).toContain('already exists');
  expect(await readFile(skill, 'utf8')).toBe('Customized skill');
});

it('reports occupied and mismatched ports without starting another board', async () => {
  const cwd = await directory();
  const port = await unusedPort();
  const first = run(
    ['--config', join(cwd, 'first.yaml'), '--no-open', '--port', String(port)],
    cwd,
  );
  const address = await first.started();
  const blocked = await run(
    ['--config', join(cwd, 'second.yaml'), '--no-open', '--port', String(port)],
    cwd,
  ).result();
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain('EADDRINUSE');
  expect((await fetch(`${address}/health`)).ok).toBe(true);
  const mismatch = await run(
    [
      '--config',
      join(cwd, 'first.yaml'),
      '--no-open',
      '--port',
      String(port === 65535 ? 4100 : port + 1),
    ],
    cwd,
  ).result();
  expect(mismatch.code).toBe(1);
  expect(mismatch.stderr).toContain('does not match config.url');
});

it('generates host-specific config without creating local state and rejects unknown hosts', async () => {
  const cwd = await directory();
  const config = join(cwd, 'a config.yaml');
  const guide = await run(['setup', '--host', 'claude-code', '--config', config], cwd).result();
  expect(guide.code).toBe(0);
  expect(guide.stdout).toContain('"mcpServers"');
  expect(guide.stdout).toContain(JSON.stringify(config));
  expect(guide.stdout).not.toContain('[mcp_servers');
  await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
  const invalid = await run(['setup', '--host', 'unknown'], cwd).result();
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('Host must be');
});

it('only creates missing configurations and preserves custom profiles', async () => {
  const cwd = await directory();
  const path = join(cwd, 'custom.yaml');
  expect((await loadStartupConfig(path, 43210)).created).toBe(true);
  const custom = 'url: http://127.0.0.1:43210\nagents: {}\nhumans:\n  owner: {}\n';
  await writeFile(path, custom);
  expect((await loadStartupConfig(path)).config.humans).toEqual({ owner: {} });
  expect(await readFile(path, 'utf8')).toBe(custom);
});
