import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Board } from '../src/board.js';
import { createApp } from '../src/app.js';

const config = {
  url: 'http://127.0.0.1:4100',
  humans: { dax: { display_name: 'Dax' }, sam: {} },
  agents: { coder: { role: 'implementer' } },
};
const access = 'profile-test-agent-access';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(database = ':memory:') {
  const board = new Board({ database, config, agentToken: access });
  const app = await createApp(board, { sweepInterval: 1000000 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    board.close();
  };
  cleanup.push(close);
  const call = (method: 'GET' | 'PATCH' | 'POST', path: string, payload?: object, human = 'dax') =>
    app.inject({
      method,
      url: `/api${path}`,
      headers: { 'x-baton-client': 'local', 'x-baton-human': human },
      ...(payload ? { payload } : {}),
    });
  return { board, app, call, close };
}

it('updates only the current human nickname and preserves task and mention identity', async () => {
  const f = await fixture();
  const task = (
    await f.call('POST', '/tasks', { title: 'Keep attribution', type: 'question' })
  ).json().data;
  const message = await f.call('POST', '/messages', {
    task_id: task.id,
    body: '@dax please review',
  });
  expect(message.statusCode).toBe(200);
  const cursor = f.board.eventCursor();
  const result = await f.call('PATCH', '/profile', { display_name: '  小达 🌿  ' });
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({
    handle: 'dax',
    kind: 'human',
    display_name: '小达 🌿',
  });
  expect((await f.call('GET', '/whoami')).json().data.participant.display_name).toBe('小达 🌿');
  expect(f.board.localHuman('sam').display_name).toBeNull();
  expect((await f.call('GET', `/tasks/${task.id}`)).json().data.creator).toBe('dax');
  expect(
    f.board.store.get('SELECT author FROM messages WHERE id=?', message.json().data.id),
  ).toEqual({ author: 'dax' });
  expect(
    f.board.store.get('SELECT handle FROM mentions WHERE message_id=?', message.json().data.id),
  ).toEqual({ handle: 'dax' });
  expect(f.board.eventCursor()).toBeGreaterThan(cursor);
  expect(f.board.store.get('SELECT type,actor FROM events ORDER BY id DESC LIMIT 1')).toEqual({
    type: 'participant.updated',
    actor: 'dax',
  });
});

it('rejects agent edits, identity changes and invalid nicknames without partial updates', async () => {
  const f = await fixture();
  const session = f.board.join(access, { handle: 'coder' }).data.session_id;
  const denied = await f.app.inject({
    method: 'PATCH',
    url: '/api/profile',
    payload: { display_name: 'Impersonation' },
    headers: { authorization: `Bearer ${access}`, 'x-baton-session': session },
  });
  expect(denied.statusCode).toBe(403);
  for (const payload of [
    {},
    { display_name: null },
    { display_name: 'x'.repeat(81) },
    { display_name: 'Sam', handle: 'sam' },
  ]) {
    expect((await f.call('PATCH', '/profile', payload)).statusCode).toBe(400);
  }
  expect(f.board.localHuman().display_name).toBe('Dax');
  expect(f.board.localHuman('sam').display_name).toBeNull();
});

it('migrates existing data and preserves saved or cleared nicknames across server restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-profile-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'board.sqlite');
  let f = await fixture(database);
  const task = (await f.call('POST', '/tasks', { title: 'Existing task', type: 'question' })).json()
    .data;
  await f.close();
  const legacy = new DatabaseSync(database);
  try {
    legacy.exec(
      `ALTER TABLE participants DROP COLUMN display_name_override;
       ALTER TABLE worker_runs DROP COLUMN submitted_commit_sha;
       ALTER TABLE worker_runs DROP COLUMN evidence_directory;
       ALTER TABLE worker_runs DROP COLUMN evidence;
       ALTER TABLE messages DROP COLUMN run_id;
       PRAGMA user_version=5;`,
    );
  } finally {
    legacy.close();
  }
  f = await fixture(database);
  expect(f.board.localHuman().display_name).toBe('Dax');
  expect((await f.call('GET', `/tasks/${task.id}`)).json().data.title).toBe('Existing task');
  expect((await f.call('PATCH', '/profile', { display_name: '小达' })).statusCode).toBe(200);
  await f.close();
  f = await fixture(database);
  expect(f.board.localHuman().display_name).toBe('小达');
  expect(
    (await f.call('PATCH', '/profile', { display_name: '   ' })).json().data.display_name,
  ).toBeNull();
  await f.close();
  f = await fixture(database);
  expect(f.board.localHuman().display_name).toBeNull();
  expect(f.board.localHuman().handle).toBe('dax');
  expect((await f.call('GET', `/tasks/${task.id}`)).json().data.title).toBe('Existing task');
});
