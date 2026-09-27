import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Board } from '../src/board.js';
import { createApp } from '../src/app.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  let now = Date.parse('2026-09-27T01:00:00Z');
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'baton-dashboard-'));
  cleanup.push(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const token = 'dashboard-test-access';
  const board = new Board({
    database: ':memory:',
    agentToken: token,
    evidenceDirectory,
    now: () => now,
    resolveRepository: async (path) => path,
    verifyCommit: async () => {},
    config: {
      url: 'http://127.0.0.1:4100',
      humans: { dax: {} },
      agents: {
        planner: { role: 'planner' },
        coder: { role: 'implementer' },
        tester: { role: 'tester' },
      },
    },
  });
  const app = await createApp(board, { sweepInterval: 1000000 });
  cleanup.push(async () => {
    await app.close();
    board.close();
  });
  const sessions = new Map<string, string>();
  async function request(
    as: string | undefined,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: object,
  ) {
    if (as && as !== 'dax' && !sessions.has(as))
      sessions.set(as, board.join(token, { handle: as }).data.session_id);
    return app.inject({
      method,
      url: `/api${path}`,
      headers:
        as === 'dax'
          ? { 'x-baton-client': 'local' }
          : {
              authorization: `Bearer ${token}`,
              ...(as ? { 'x-baton-session': sessions.get(as)! } : {}),
            },
      ...(body ? { payload: body } : {}),
    });
  }
  async function ok(
    as: string | undefined,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: object,
  ) {
    const response = await request(as, method, path, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data;
  }
  const task = (title: string, extra: object = {}) =>
    ok('dax', 'POST', '/tasks', { title, type: 'question', ...extra });
  return {
    board,
    request,
    ok,
    task,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

it('searches every task by title or ID, escapes SQL wildcards and paginates before rendering', async () => {
  const f = await fixture();
  const first = await f.task('修复 100%_数据');
  await f.task('修复 100AA数据');
  for (let i = 0; i < 23; i++) await f.task(`后台任务 ${i}`);
  expect(
    (await f.ok('dax', 'GET', `/tasks?search=${encodeURIComponent('%_')}`)).map(
      (t: { id: number }) => t.id,
    ),
  ).toEqual([first.id]);
  expect((await f.ok('dax', 'GET', `/tasks?search=T-${first.id}`))[0].id).toBe(first.id);
  expect(
    await f.ok('dax', 'GET', `/tasks?search=${encodeURIComponent('后台任务')}&offset=20&limit=20`),
  ).toHaveLength(3);
  expect(await f.ok('dax', 'GET', `/tasks?search=${encodeURIComponent("' OR 1=1 --")}`)).toEqual(
    [],
  );
  const child = await f.task('依赖任务', { depends_on: [first.id] });
  expect(
    (await f.ok('dax', 'GET', `/tasks?depends_on=${first.id}`)).map((t: { id: number }) => t.id),
  ).toEqual([child.id]);
  expect(await f.ok('dax', 'GET', '/tasks?type=plan')).toEqual([]);
});

it('orders the complete attention queue before pagination and preserves the original waiting time', async () => {
  const f = await fixture();
  const first = await f.task('较早阻塞', { priority: 'P3' });
  await f.ok('dax', 'PATCH', `/tasks/${first.id}`, { frozen: true });
  const since = (await f.ok('dax', 'GET', '/attention')).items[0].since;
  for (let i = 0; i < 12; i++) {
    f.advance(1000);
    const task = await f.task(`待处理 ${i}`, { priority: 'P2' });
    await f.ok('dax', 'PATCH', `/tasks/${task.id}`, { frozen: true });
  }
  f.advance(1000);
  const urgent = await f.task('紧急项', { priority: 'P0' });
  await f.ok('dax', 'PATCH', `/tasks/${urgent.id}`, { frozen: true });
  const queue = await f.ok('dax', 'GET', '/attention?limit=1&sort=priority');
  expect(queue.total).toBe(14);
  expect(queue.items[0].task.id).toBe(urgent.id);
  await f.ok('dax', 'PATCH', `/tasks/${first.id}`, { title: '改名仍保留等待起点' });
  const oldest = (await f.ok('dax', 'GET', '/attention?limit=1&sort=waiting')).items[0];
  expect(oldest.task.id).toBe(first.id);
  expect(oldest.since).toBe(since);
  await f.task('受影响的后续任务', { depends_on: [first.id] });
  const impacted = (await f.ok('dax', 'GET', '/attention?limit=1&sort=impact')).items[0];
  expect(impacted.task.id).toBe(first.id);
  expect(impacted.impact).toBe(1);
  expect((await f.ok('dax', 'GET', '/attention?limit=10&offset=10')).items).toHaveLength(4);
  expect((await f.request('coder', 'GET', '/attention')).statusCode).toBe(403);
});

it('keeps read questions actionable until resolved and never exposes another participant private messages', async () => {
  const f = await fixture();
  await f.ok('planner', 'POST', '/messages', {
    to: 'dax',
    kind: 'question',
    body: '需要确认范围 @dax',
  });
  await f.ok('coder', 'POST', '/messages', {
    to: 'tester',
    kind: 'question',
    body: 'private reviewer question',
  });
  const queue = await f.ok('dax', 'GET', '/attention?kind=question');
  expect(queue.total).toBe(1);
  const item = queue.items[0];
  expect(item.reason).toContain('需要确认范围');
  await f.ok('dax', 'POST', '/inbox/mark', { ids: [item.mention.id] });
  expect((await f.ok('dax', 'GET', '/attention?kind=question')).total).toBe(1);
  await f.ok('dax', 'POST', '/inbox/mark', { ids: [item.mention.id], resolve: true });
  expect((await f.ok('dax', 'GET', '/attention?kind=question')).total).toBe(0);
  const followup = await f.ok('planner', 'POST', '/messages', {
    to: 'dax',
    kind: 'question',
    body: '请确认验收范围',
  });
  await f.ok('dax', 'POST', '/messages', {
    to: 'planner',
    body: '范围已确认',
    reply_to: followup.id,
  });
  expect((await f.ok('dax', 'GET', '/attention?kind=question')).total).toBe(0);
});

it('retains each implementation and review version and verdict through rework without inventing legacy results', async () => {
  const f = await fixture();
  const plan = await f.task('开发计划', { type: 'plan' });
  const task = await f.task('实现内容', {
    type: 'implement',
    parent_id: plan.id,
    repository: resolve('/dashboard-test-repo'),
    acceptance_criteria: ['符合范围'],
  });
  await f.ok('dax', 'POST', `/tasks/${plan.id}/transition`, {
    status: 'open',
    reason: 'Approve scope',
  });
  const coder = await f.ok('planner', 'POST', `/tasks/${task.id}/dispatch`, {
    mode: 'implement',
    handle: 'coder',
  });
  await writeFile(
    join(coder.evidence_directory, 'checks.log'),
    'A failed check with an explicit scope',
  );
  await f.ok(undefined, 'POST', `/workers/${coder.run_id}/submit`, {
    summary: '第一版结果',
    commit_sha: 'a'.repeat(40),
    evidence: [
      {
        path: 'checks.log',
        scope: 'Only local unit checks',
        command: ['node', '--test'],
        exit_code: 1,
      },
    ],
  });
  f.advance(1000);
  const tester = await f.ok('planner', 'POST', `/tasks/${task.id}/dispatch`, {
    mode: 'review',
    handle: 'tester',
  });
  await f.ok(undefined, 'POST', `/workers/${tester.run_id}/review`, {
    verdict: 'changes_requested',
    comments: '边界条件失败',
    commit_sha: 'a'.repeat(40),
  });
  f.advance(1000);
  const retry = await f.ok('planner', 'POST', `/tasks/${task.id}/dispatch`, {
    mode: 'implement',
    handle: 'coder',
  });
  await f.ok(undefined, 'POST', `/workers/${retry.run_id}/submit`, {
    summary: '第二版结果',
    commit_sha: 'b'.repeat(40),
  });
  const rounds = await f.ok('dax', 'GET', `/tasks/${task.id}/runs?limit=2`);
  expect(rounds.total).toBe(3);
  expect(rounds.items[0]).toMatchObject({
    submitted_commit_sha: 'b'.repeat(40),
    outcome: 'submitted',
    summary: '第二版结果',
  });
  expect(rounds.items[1]).toMatchObject({
    commit_sha: 'a'.repeat(40),
    outcome: 'changes_requested',
    summary: '边界条件失败',
  });
  const original = (await f.ok('dax', 'GET', `/tasks/${task.id}/runs?offset=2`)).items[0];
  expect(original.submitted_commit_sha).toBe('a'.repeat(40));
  expect(original.evidence[0]).toMatchObject({
    run_id: coder.run_id,
    exit_code: 1,
    commit_sha: 'a'.repeat(40),
  });
  const legacyRun = randomUUID();
  const privateReport = await f.ok('tester', 'POST', '/messages', {
    to: 'coder',
    kind: 'report',
    body: 'Private review note',
  });
  f.board.store.run('UPDATE messages SET run_id=? WHERE id=?', legacyRun, privateReport.id);
  f.board.store.run(
    "INSERT INTO worker_runs(id,task_id,handle,coordinator,mode,state,commit_sha,lease_until,created_at) VALUES(?,?,'tester','planner','review','completed',?,?,?)",
    legacyRun,
    task.id,
    'c'.repeat(40),
    '2026-09-26T01:00:00Z',
    '2026-09-26T00:00:00Z',
  );
  f.board.store.run(
    "INSERT INTO events(actor,type,task_id,payload,created_at) VALUES('tester','worker.completed',?,?,?)",
    task.id,
    JSON.stringify({ run_id: legacyRun, evidence: [] }),
    '2026-09-26T01:00:00Z',
  );
  const historical = (await f.ok('dax', 'GET', `/tasks/${task.id}/runs`)).items.find(
    (run: { run_id: string }) => run.run_id === legacyRun,
  );
  expect(historical.outcome).toBeNull();
  expect(historical.summary).toBeNull();
  expect(historical.commit_sha).toBe('c'.repeat(40));
  expect((await f.request('dax', 'GET', '/tasks/99999/runs')).statusCode).toBe(404);
});
