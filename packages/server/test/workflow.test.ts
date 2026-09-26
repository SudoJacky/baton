import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { settingsSchema, type Task, type WorkerAssignment, type BoardConfig } from '@baton/shared';
import { Board } from '../src/board.js';
import { createApp } from '../src/app.js';

const config: BoardConfig = {
  url: 'http://127.0.0.1:4100',
  humans: { dax: {} },
  agents: {
    planner: { role: 'planner' },
    coder: { role: 'implementer' },
    tester: { role: 'tester' },
    coder2: { role: 'implementer' },
  },
};
const access = 'workflow-test-local-access';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  let now = Date.now();
  const verify = vi.fn<(repo: string, sha: string) => Promise<void>>().mockResolvedValue(undefined);
  const board = new Board({
    database: ':memory:',
    config,
    agentToken: access,
    now: () => now,
    resolveRepository: async (p) => p,
    verifyCommit: verify,
  });
  const app = await createApp(board, { sweepInterval: 1000000 });
  closes.push(async () => {
    await app.close();
    board.close();
  });
  const sessions = new Map<string, string>();
  const request = async (
    as: string | undefined,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: object,
  ) => {
    if (as && as !== 'dax' && !sessions.has(as))
      sessions.set(as, board.join(access, { handle: as }).data.session_id);
    const headers =
      as === 'dax'
        ? { 'x-baton-client': 'local' }
        : {
            authorization: `Bearer ${access}`,
            ...(as ? { 'x-baton-session': sessions.get(as)! } : {}),
          };
    const r = await app.inject({
      method,
      url: `/api${path}`,
      headers,
      ...(body ? { payload: body } : {}),
    });
    return { status: r.statusCode, ...r.json() };
  };
  const ok = async (
    as: string | undefined,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: object,
  ) => {
    const result = await request(as, method, path, body);
    expect(result.status, JSON.stringify(result)).toBe(200);
    return result.data;
  };
  const plan = async () =>
    ok('planner', 'POST', '/tasks', { title: 'Approved workflow', type: 'plan' });
  const child = async (parent: number, extra: object = {}) =>
    ok('planner', 'POST', '/tasks', {
      title: 'Implementation',
      type: 'implement',
      parent_id: parent,
      repository: resolve('/workflow-repo'),
      acceptance_criteria: ['Correct output', 'Regression passes'],
      ...extra,
    });
  const approve = async (id: number) => {
    await ok('planner', 'POST', `/tasks/${id}/approval-requests`, {
      to_status: 'open',
      reason: 'Scope ready',
    });
    return ok('dax', 'POST', `/tasks/${id}/transition`, {
      status: 'open',
      reason: 'Approved scope',
    });
  };
  const dispatch = (
    id: number,
    mode: 'implement' | 'review',
    handle = mode === 'implement' ? 'coder' : 'tester',
  ): Promise<WorkerAssignment> => ok('planner', 'POST', `/tasks/${id}/dispatch`, { mode, handle });
  const submit = (run: WorkerAssignment, sha = 'a'.repeat(40)) =>
    ok(undefined, 'POST', `/workers/${run.run_id}/submit`, {
      summary: 'Implementation committed',
      commit_sha: sha,
    });
  const review = (run: WorkerAssignment, verdict = 'approve') =>
    ok(undefined, 'POST', `/workers/${run.run_id}/review`, {
      verdict,
      comments: 'Independent checks executed',
      commit_sha: run.commit_sha,
      criteria_passed: run.task.acceptance_criteria.map((c) => c.id),
    });
  return {
    board,
    request,
    ok,
    plan,
    child,
    approve,
    dispatch,
    submit,
    review,
    verify,
    advance: (ms: number) => {
      now += ms;
      board.sweep();
    },
  };
}

it('approves one plan, executes dependent work with separate workers, retries and closes without further human gates', async () => {
  const f = await fixture();
  const plan = await f.plan();
  expect(plan.status).toBe('draft');
  const task = await f.child(plan.id);
  const next = await f.child(plan.id, { title: 'Follow-up', depends_on: [task.id] });
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder',
      })
    ).error.code,
  ).toBe('plan_approval_required');
  expect((await f.request('coder', 'POST', `/tasks/${task.id}/claim`, {})).error.code).toBe(
    'plan_approval_required',
  );
  expect(
    (await f.request('planner', 'PATCH', `/tasks/${plan.id}`, { status: 'open' })).status,
  ).toBe(403);
  await f.approve(plan.id);
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${next.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder2',
      })
    ).error.code,
  ).toBe('dependencies_pending');
  const coding = await f.dispatch(task.id, 'implement');
  expect(coding.task.status).toBe('in_progress');
  expect((await f.dispatch(task.id, 'implement')).run_id).toBe(coding.run_id);
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder2',
      })
    ).error.code,
  ).toBe('worker_active');
  await f.ok(undefined, 'POST', `/workers/${coding.run_id}/messages`, {
    body: 'Progress @types/node',
  });
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${coding.run_id}/messages`, {
        body: 'wrong destination',
        task_id: next.id,
      })
    ).status,
  ).toBe(400);
  await f.submit(coding);
  expect(f.board.lock(task.repository).task_id).toBe(task.id);
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${coding.run_id}/submit`, {
        summary: 'stale',
        commit_sha: 'a'.repeat(40),
      })
    ).error.code,
  ).toBe('worker_inactive');
  const testing = await f.dispatch(task.id, 'review');
  expect(testing.commit_sha).toBe('a'.repeat(40));
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${testing.run_id}/review`, {
        verdict: 'approve',
        comments: 'Missing criteria',
        commit_sha: testing.commit_sha,
      })
    ).error.code,
  ).toBe('criteria_incomplete');
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${testing.run_id}/review`, {
        verdict: 'approve',
        comments: 'Wrong revision',
        commit_sha: 'b'.repeat(40),
        criteria_passed: testing.task.acceptance_criteria.map((c) => c.id),
      })
    ).error.code,
  ).toBe('review_version_mismatch');
  const rejected = await f.review(testing, 'changes_requested');
  expect(rejected.task).toMatchObject({ status: 'changes_requested', attempt: 1 });
  const fixing = await f.dispatch(task.id, 'implement');
  expect(fixing.run_id).not.toBe(coding.run_id);
  // A same-SHA resubmission must still record the current submitted revision.
  await f.submit(fixing);
  const retest = await f.dispatch(task.id, 'review');
  const done = await f.review(retest);
  expect(done.task.status).toBe('done');
  expect(
    done.task.acceptance_criteria.every((c: { checked_by: string }) => c.checked_by === 'tester'),
  ).toBe(true);
  expect(f.board.lock(task.repository).holder).toBeNull();
  expect(await f.ok('dax', 'GET', '/approvals')).toHaveLength(0);
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${plan.id}/complete-plan`, {
        summary: 'too early',
      })
    ).error.code,
  ).toBe('plan_incomplete');
  await f.submit(await f.dispatch(next.id, 'implement'), 'b'.repeat(40));
  await f.review(await f.dispatch(next.id, 'review'));
  expect(
    (
      await f.ok('planner', 'POST', `/tasks/${plan.id}/complete-plan`, {
        summary: 'Both deliverables reviewed',
      })
    ).status,
  ).toBe('done');
  expect(f.verify).toHaveBeenCalled();
});

it('locks approved scope, prevents self review and keeps shared-directory writers out during review', async () => {
  const f = await fixture();
  const plan = await f.plan();
  const task = await f.child(plan.id);
  const second = await f.child(plan.id);
  await f.approve(plan.id);
  expect(
    (
      await f.request('planner', 'POST', '/tasks', {
        title: 'Unapproved extra',
        type: 'implement',
        parent_id: plan.id,
      })
    ).error.code,
  ).toBe('plan_scope_locked');
  expect(
    (await f.request('dax', 'PATCH', `/tasks/${task.id}`, { acceptance_criteria: ['easier'] }))
      .error.code,
  ).toBe('plan_scope_locked');
  expect(
    (await f.request('planner', 'POST', '/tasks', { title: 'Bypass', type: 'bug' })).error.code,
  ).toBe('plan_required');
  await f.submit(await f.dispatch(task.id, 'implement'));
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'review',
        handle: 'coder',
      })
    ).error.code,
  ).toBe('worker_role_mismatch');
  expect(
    (
      await f.request('coder', 'POST', `/tasks/${task.id}/review`, {
        verdict: 'approve',
        comments: 'self',
      })
    ).error.code,
  ).toBe('self_review');
  await f.dispatch(task.id, 'review');
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${second.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder2',
      })
    ).error.code,
  ).toBe('write_lock_held');
  expect((await f.ok('planner', 'GET', `/tasks/${second.id}`)).assignee).toBeNull();
  expect(
    (
      await f.request('dax', 'POST', `/tasks/${plan.id}/transition`, {
        status: 'cancelled',
        reason: 'cancel scope',
      })
    ).error.code,
  ).toBe('plan_has_active_tasks');
});

it('requires concrete scope before approval and verified plan criteria before completion', async () => {
  const f = await fixture();
  const plan = await f.ok('planner', 'POST', '/tasks', {
    title: 'Concrete plan',
    type: 'plan',
    acceptance_criteria: ['All deliverables verified'],
  });
  expect(
    (
      await f.request('dax', 'POST', `/tasks/${plan.id}/transition`, {
        status: 'open',
        reason: 'premature',
      })
    ).error.code,
  ).toBe('plan_scope_incomplete');
  const task = await f.child(plan.id, { repository: undefined });
  expect(
    (
      await f.request('dax', 'POST', `/tasks/${plan.id}/transition`, {
        status: 'open',
        reason: 'missing repository',
      })
    ).error.code,
  ).toBe('plan_scope_incomplete');
  await f.ok('dax', 'PATCH', `/tasks/${task.id}`, { repository: resolve('/workflow-repo') });
  await f.approve(plan.id);
  await f.submit(await f.dispatch(task.id, 'implement'));
  await f.review(await f.dispatch(task.id, 'review'));
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${plan.id}/complete-plan`, {
        summary: 'missing plan verification',
      })
    ).error.code,
  ).toBe('criteria_incomplete');
  const done = await f.ok('planner', 'POST', `/tasks/${plan.id}/complete-plan`, {
    summary: 'All deliverables checked',
    criteria_passed: plan.acceptance_criteria.map((c: { id: number }) => c.id),
  });
  expect(done.acceptance_criteria[0].checked).toBe(true);
});

it('replaces a stopped reviewer without coding again and automatically requests a preserved custom final gate', async () => {
  const f = await fixture();
  const plan = await f.plan();
  const task = await f.child(plan.id);
  await f.approve(plan.id);
  await f.submit(await f.dispatch(task.id, 'implement'));
  const old = await f.dispatch(task.id, 'review');
  await f.ok('planner', 'POST', `/workers/${old.run_id}/stop`, {
    reason: 'Reviewer exited; process is stopped',
  });
  const replacement = await f.dispatch(task.id, 'review');
  expect(replacement.run_id).not.toBe(old.run_id);
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${old.run_id}/review`, {
        verdict: 'changes_requested',
        comments: 'stale',
        commit_sha: old.commit_sha,
      })
    ).error.code,
  ).toBe('worker_inactive');
  await f.ok('dax', 'PUT', '/settings', { approval_mode: 'custom' });
  const result = await f.review(replacement);
  expect(result).toMatchObject({ state: 'completed', task: { status: 'in_review' } });
  expect(await f.ok('dax', 'GET', '/approvals')).toHaveLength(1);
  expect(
    (
      await f.ok('dax', 'POST', `/tasks/${task.id}/transition`, {
        status: 'done',
        reason: 'Custom approval honored',
      })
    ).status,
  ).toBe('done');
});

it('escalates at the retry limit and expired worker runs cannot reclaim or change the task', async () => {
  const f = await fixture();
  await f.ok('dax', 'PUT', '/settings', { max_attempts: 1 });
  const plan = await f.plan();
  const task = await f.child(plan.id);
  await f.approve(plan.id);
  await f.submit(await f.dispatch(task.id, 'implement'));
  const result = await f.review(await f.dispatch(task.id, 'review'), 'changes_requested');
  expect(result.task.status).toBe('blocked');
  f.advance(3600000);
  expect((await f.ok('planner', 'GET', `/tasks/${task.id}`)).assignee).toBe('coder');
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder',
      })
    ).error.code,
  ).toBe('attempt_limit');
  const plan2 = await f.plan();
  const task2 = await f.child(plan2.id, { repository: resolve('/other-repo') });
  await f.approve(plan2.id);
  const run = await f.dispatch(task2.id, 'implement', 'coder2');
  const before = f.board.eventCursor();
  f.advance(60000);
  await f.ok(undefined, 'POST', `/workers/${run.run_id}/heartbeat`, {});
  expect(f.board.eventCursor()).toBe(before);
  f.advance(3600000);
  const expired = await f.ok(undefined, 'GET', `/workers/${run.run_id}`);
  expect(expired).toMatchObject({
    state: 'expired',
    task: { status: 'blocked', assignee: 'coder2' },
  });
  expect(f.board.lock(task2.repository).task_id).toBe(task2.id);
  expect(
    (
      await f.request(undefined, 'POST', `/workers/${run.run_id}/submit`, {
        summary: 'late',
        commit_sha: 'a'.repeat(40),
      })
    ).error.code,
  ).toBe('worker_inactive');
});

it('gates optional merge execution and freezes reported conflicts for human recovery', async () => {
  const f = await fixture();
  await f.ok('dax', 'PUT', '/settings', { merge_approval: true });
  const plan = await f.plan();
  const task = await f.child(plan.id, { type: 'merge' });
  await f.approve(plan.id);
  expect(task.status).toBe('draft');
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder',
      })
    ).error.code,
  ).toBe('approval_required');
  await f.approve(task.id);
  const run = await f.dispatch(task.id, 'implement');
  await f.ok(undefined, 'POST', `/workers/${run.run_id}/messages`, {
    body: 'Conflicting file src/app.ts',
    escalation: 'merge_conflict',
  });
  const blocked = await f.ok('planner', 'GET', `/tasks/${task.id}`);
  expect(blocked).toMatchObject({ status: 'blocked', frozen: true });
  expect(
    (
      await f.request('planner', 'POST', `/tasks/${task.id}/dispatch`, {
        mode: 'implement',
        handle: 'coder',
      })
    ).error.code,
  ).toBe('task_frozen');
  expect(
    (await f.ok('dax', 'GET', '/overview')).attention.some((t: Task) => t.id === task.id),
  ).toBe(true);
  const follow = await f.plan();
  const auto = await f.child(follow.id, { type: 'merge', repository: resolve('/merge2') });
  await f.ok('dax', 'PUT', '/settings', { merge_approval: false });
  // Turning the gate off must make an existing draft dispatchable without another human action.
  await f.approve(follow.id);
  expect((await f.dispatch(auto.id, 'implement', 'coder2')).task.status).toBe('in_progress');
});

it('rechecks frozen state and run ownership after asynchronous Git verification', async () => {
  const f = await fixture();
  const plan = await f.plan();
  const task = await f.child(plan.id);
  await f.approve(plan.id);
  const run = await f.dispatch(task.id, 'implement');
  let release!: () => void;
  f.verify.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const pending = f.request(undefined, 'POST', `/workers/${run.run_id}/submit`, {
    summary: 'race',
    commit_sha: 'a'.repeat(40),
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.ok('planner', 'POST', `/workers/${run.run_id}/stop`, { reason: 'Worker stopped' });
  release();
  expect((await pending).error.code).toBe('task_changed');
  expect((await f.ok('planner', 'GET', `/tasks/${task.id}`)).status).toBe('blocked');
});

it.each(['stock', 'custom'] as const)(
  'migrates a v4 %s policy without erasing custom settings or existing task state',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-workflow-migration-'));
    const database = join(directory, 'board.sqlite');
    closes.push(() => rm(directory, { recursive: true, force: true }));
    let board = new Board({ database, config, agentToken: access });
    const old = settingsSchema.parse({
      max_attempts: 7,
      ...(kind === 'custom' ? { gates: [{ from: 'open', to: 'claimed', types: ['test'] }] } : {}),
    });
    const { approval_mode: _mode, merge_approval: _merge, ...legacy } = old;
    const oldPlan = (
      await board.execute(board.localHuman(), 'create_task', { title: 'Legacy plan', type: 'plan' })
    ).data as Task;
    const oldChild = (
      await board.execute(board.localHuman(), 'create_task', {
        title: 'Legacy work',
        type: 'test',
        parent_id: oldPlan.id,
      })
    ).data as Task;
    board.store.run("UPDATE tasks SET status='open' WHERE id=?", oldPlan.id);
    board.store.run("UPDATE settings SET value=? WHERE key='policy'", JSON.stringify(legacy));
    board.store.run('DROP TABLE worker_runs');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_at');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_by');
    board.store.run('ALTER TABLE tasks DROP COLUMN workflow_plan');
    board.store.run('PRAGMA user_version=4');
    board.close();
    board = new Board({ database, config, agentToken: access });
    closes.push(async () => board.close());
    expect(board.settings()).toMatchObject({
      approval_mode: kind === 'stock' ? 'plan' : 'custom',
      max_attempts: 7,
      gates: old.gates,
    });
    expect(board.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(5);
    expect(
      (await board.execute(board.localHuman(), 'get_task', { id: oldPlan.id })).data,
    ).toMatchObject({ status: 'open', workflow_plan: false, plan_approved_at: null });
    if (kind === 'stock') {
      const session = board.join(access, { handle: 'coder' }).data.session_id;
      expect(
        (
          await board.execute(board.authenticate(access, session), 'claim_task', {
            id: oldChild.id,
          })
        ).data,
      ).toMatchObject({ status: 'claimed' });
    }
  },
);
