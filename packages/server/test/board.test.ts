import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BoardConfig, Envelope, Task } from '@baton/shared';
import { configSchema } from '@baton/shared';
import { Board, hashToken } from '../src/board.js';
import { createApp } from '../src/app.js';
import { resolveRepository } from '../src/git.js';

const config: BoardConfig = {
  url: 'http://127.0.0.1:4100',
  agents: {
    planner: { role: 'planner' },
    coder: { role: 'implementer' },
    coder2: { role: 'implementer' },
    tester: { role: 'tester' },
  },
  humans: {
    dax: { display_name: 'Dax' },
    sam: {},
  },
};
const agentToken = 'local-agent-access-'.repeat(3);
const token = (handle: string) => (config.agents[handle] ? agentToken : `${handle}-`.repeat(8));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  options: {
    realGit?: boolean;
    database?: string;
    repository?: string;
    verifyCommit?: (repository: string, sha: string) => void | Promise<void>;
  } = {},
) {
  let now = Date.parse('2026-09-24T10:00:00Z');
  const repository = options.repository ?? resolve('/baton-fixture');
  const board = new Board({
    config,
    agentToken,
    database: options.database ?? ':memory:',
    ...(options.realGit ? {} : { resolveRepository: async (path: string) => path }),
    now: () => now,
    ...(options.realGit ? {} : { verifyCommit: () => {} }),
    ...(options.verifyCommit ? { verifyCommit: options.verifyCommit } : {}),
  });
  // Existing tests exercise the advanced/custom transition policy explicitly.
  await board.execute(board.localHuman(), 'put_settings', { approval_mode: 'custom' });
  const app = await createApp(board, { sweepInterval: 1000000 });
  cleanup.push(async () => {
    await app.close();
    board.close();
  });
  const sessions = new Map<string, string>();
  const headers = (handle: string): Record<string, string> => {
    if (config.agents[handle] && !sessions.has(handle))
      sessions.set(handle, board.join(agentToken, { handle }).data.session_id);
    return sessions.has(handle)
      ? { authorization: `Bearer ${agentToken}`, 'x-baton-session': sessions.get(handle)! }
      : { 'x-baton-client': 'local', 'x-baton-human': handle };
  };
  const call = async (
    handle: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    data?: unknown,
  ) => {
    const result = await app.inject({
      method,
      url: `/api${path}`,
      headers: headers(handle),
      ...(data === undefined ? {} : { payload: data as Record<string, unknown> }),
    });
    return { status: result.statusCode, body: result.json() };
  };
  const create = async (extra: Record<string, unknown> = {}) => {
    const r = await call('dax', 'POST', '/tasks', {
      title: 'Task',
      type: 'test',
      repository,
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.body.data as Task;
  };
  const start = async (task: Task, actor = 'coder') => {
    expect((await call(actor, 'POST', `/tasks/${task.id}/claim`, {})).status).toBe(200);
    expect(
      (await call(actor, 'PATCH', `/tasks/${task.id}`, { status: 'in_progress' })).status,
    ).toBe(200);
  };
  return {
    board,
    repository,
    app,
    headers,
    call,
    create,
    start,
    advance: (ms: number) => {
      now += ms;
      board.sweep();
    },
  };
}

describe('task collaboration and server-enforced policy', () => {
  it('keeps agent sessions distinct from explicit local human operations', async () => {
    const f = await fixture();
    const request = (path: string, payload: object, key = agentToken, session?: string) =>
      f.app.inject({
        method: 'POST',
        url: `/api${path}`,
        payload,
        headers: {
          authorization: `Bearer ${key}`,
          ...(session ? { 'x-baton-session': session } : {}),
        },
      });
    expect((await request('/agents/join', { handle: 'dax', role: 'planner' })).statusCode).toBe(
      403,
    );
    expect(
      (await request('/agents/join', { handle: 'new_coder', role: 'implementer', kind: 'human' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await request('/agents/join', { handle: 'new_coder', role: 'implementer' }, token('dax')))
        .statusCode,
    ).toBe(401);
    expect((await request('/agents/join', { handle: 'tester', role: 'planner' })).statusCode).toBe(
      409,
    );
    const joined = await request('/agents/join', { handle: 'new_coder', role: 'implementer' });
    expect(joined.statusCode).toBe(200);
    const id = joined.json().data.session_id;
    expect(joined.json().data.participant.kind).toBe('agent');
    expect(
      (
        await request(
          '/lock/acquire',
          { repository: f.repository, reason: 'impersonate a human' },
          agentToken,
          id,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          '/lock/acquire',
          { repository: f.repository, reason: 'use human token with agent identity' },
          token('dax'),
          id,
        )
      ).statusCode,
    ).toBe(401);
    expect((await request('/tasks', { title: 'Missing session', type: 'bug' })).statusCode).toBe(
      401,
    );
    expect(
      (await request('/tasks', { title: 'Unknown session', type: 'bug' }, agentToken, randomUUID()))
        .statusCode,
    ).toBe(401);
    const task = await f.create({ type: 'implement', draft: true });
    expect(
      (
        await request(
          `/tasks/${task.id}/transition`,
          { status: 'open', reason: 'skip approval' },
          agentToken,
          id,
        )
      ).statusCode,
    ).toBe(403);
  });
  it('opens as the first configured human and records approvals without a credential', async () => {
    const f = await fixture();
    const headers = { 'x-baton-client': 'local' };
    const identity = await f.app.inject({ url: '/api/whoami', headers });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().data.participant).toMatchObject({ handle: 'dax', kind: 'human' });
    const created = await f.call('planner', 'POST', '/tasks', {
      title: 'Agent proposal',
      type: 'implement',
      draft: true,
    });
    expect(created.status).toBe(200);
    const task = created.body.data as Task;
    const requested = await f.call('planner', 'POST', `/tasks/${task.id}/approval-requests`, {
      to_status: 'open',
      reason: 'Ready for approval',
    });
    expect(requested.status).toBe(200);
    const approved = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/transition`,
      headers,
      payload: { status: 'open', reason: 'Approved in the local dashboard' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.status).toBe('open');
    expect((await f.call('dax', 'GET', '/approvals')).body.data).toHaveLength(0);
    const events = (
      await f.call('dax', 'GET', `/events?task_id=${task.id}&type=task.status_changed`)
    ).body.data;
    expect(events.at(-1)).toMatchObject({ actor: 'dax', payload: { to: 'open' } });
    expect((await f.call('sam', 'GET', '/whoami')).body.data.participant.handle).toBe('sam');
    expect(
      (
        await f.app.inject({
          url: '/api/whoami',
          headers: { ...headers, 'x-baton-human': 'coder' },
        })
      ).statusCode,
    ).toBe(403);
    for (const extra of [
      { authorization: 'Bearer invalid' },
      { authorization: `Bearer ${agentToken}` },
      { 'x-baton-session': randomUUID() },
      f.headers('coder'),
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/lock/acquire',
            headers: { ...headers, ...extra },
            payload: { reason: 'Do not fall back to a human' },
          })
        ).statusCode,
      ).toBe(401);
    }
  });
  it('ignores unknown inline mentions but validates explicit mentions', async () => {
    const f = await fixture();
    const body = 'Upgrade @types/node; @ts-ignore and @baton/shared. Ask @human.';
    expect((await f.call('coder', 'POST', '/messages', { channel: 'general', body })).status).toBe(
      200,
    );
    expect((await f.call('dax', 'GET', '/inbox')).body.data).toHaveLength(1);
    expect(
      (
        await f.call('coder', 'POST', '/messages', {
          channel: 'general',
          body,
          mentions: ['missing'],
        })
      ).status,
    ).toBe(404);
    const task = await f.create();
    await f.start(task);
    expect(
      (await f.call('coder', 'POST', `/tasks/${task.id}/submit`, { summary: body })).status,
    ).toBe(200);
    expect(
      (
        await f.call('tester', 'POST', `/tasks/${task.id}/review`, {
          verdict: 'changes_requested',
          comments: body,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call('coder', 'POST', `/tasks/${task.id}/release`, { reason: body })).status,
    ).toBe(200);
  });
  it('keeps blocked tasks assigned after their lease and counts them against claim limits', async () => {
    const f = await fixture();
    const task = await f.create();
    const next = await f.create();
    await f.start(task);
    await f.call('coder', 'PATCH', `/tasks/${task.id}`, { status: 'blocked', note: 'Need @human' });
    expect((await f.call('coder', 'POST', `/tasks/${next.id}/claim`, {})).body.error?.code).toBe(
      'task_limit',
    );
    f.advance(31 * 60000);
    expect((await f.call('dax', 'GET', `/tasks/${task.id}`)).body.data).toMatchObject({
      status: 'blocked',
      assignee: 'coder',
    });
    expect(
      (await f.call('dax', 'GET', '/overview')).body.data.attention.map((t: Task) => t.id),
    ).toContain(task.id);
  });
  it('updates activity without heartbeat events and keeps idle sessions resumable', async () => {
    const f = await fixture();
    await f.call('coder', 'GET', '/whoami');
    const before = (await f.call('dax', 'GET', '/overview')).body.data.event_cursor;
    f.advance(1000);
    expect((await f.call('coder', 'GET', '/whoami')).status).toBe(200);
    expect((await f.call('dax', 'GET', '/overview')).body.data.event_cursor).toBe(before);
    f.advance(90000);
    const participants = (await f.call('dax', 'GET', '/participants')).body.data;
    expect(participants.find((p: { handle: string }) => p.handle === 'coder').status).toBe(
      'offline',
    );
    expect((await f.call('coder', 'GET', '/whoami')).body.data.participant.status).toBe('online');
  });
  it('retains an expired in-progress writer and sends its warning only once', async () => {
    const f = await fixture();
    const task = await f.create({ type: 'bug' });
    await f.start(task);
    f.advance(31 * 60000);
    const expired = (await f.call('dax', 'GET', `/tasks/${task.id}`)).body.data;
    expect(expired).toMatchObject({ status: 'in_progress', assignee: 'coder' });
    expect(expired.lease_expired_at).toBeTruthy();
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .task_id,
    ).toBe(task.id);
    const cursor = (await f.call('dax', 'GET', '/overview')).body.data.event_cursor;
    f.advance(60000);
    expect((await f.call('dax', 'GET', '/overview')).body.data.event_cursor).toBe(cursor);
  });
  it('lets the independent reviewer check criteria and rejects self-certification', async () => {
    const f = await fixture();
    const task = await f.create({ acceptance_criteria: ['Verified'] });
    await f.start(task);
    const criteria_check = [{ id: task.acceptance_criteria[0]!.id, checked: true }];
    await f.call('coder', 'POST', `/tasks/${task.id}/submit`, {
      summary: 'Ready',
      reviewer: 'tester',
    });
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${task.id}`, { criteria_check })).body.error?.code,
    ).toBe('self_review');
    expect((await f.call('tester', 'PATCH', `/tasks/${task.id}`, { criteria_check })).status).toBe(
      200,
    );
    expect(
      (
        await f.call('tester', 'PATCH', `/tasks/${task.id}`, {
          criteria_check,
          artifacts_add: [{ kind: 'file', ref: 'unexpected' }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call('tester', 'POST', `/tasks/${task.id}/review`, {
          verdict: 'approve',
          comments: 'Pass',
        })
      ).body.data.status,
    ).toBe('done');
  });
  it('preserves custom gates when changing one policy field', async () => {
    const f = await fixture();
    const gates = [{ from: 'open', to: 'claimed', types: ['test'] }];
    await f.call('dax', 'PUT', '/settings', { gates });
    const result = await f.call('dax', 'PUT', '/settings', { max_attempts: 5 });
    expect(result.body.data.gates).toEqual(gates);
    expect(result.body.data.max_attempts).toBe(5);
  });
  it('allows a human to repair cancelled dependencies while rejecting cycles and agent edits', async () => {
    const f = await fixture();
    const prerequisite = await f.create();
    const downstream = await f.create({ depends_on: [prerequisite.id] });
    await f.call('dax', 'POST', `/tasks/${prerequisite.id}/transition`, {
      status: 'cancelled',
      reason: 'No longer needed',
    });
    expect(
      (await f.call('coder', 'POST', `/tasks/${downstream.id}/claim`, {})).body.error.code,
    ).toBe('dependencies_pending');
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${downstream.id}`, { depends_on: [] })).status,
    ).toBe(403);
    const replacement = await f.create({ depends_on: [downstream.id] });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${downstream.id}`, { depends_on: [replacement.id] }))
        .body.error.code,
    ).toBe('dependency_cycle');
    expect((await f.call('dax', 'GET', `/tasks/${downstream.id}`)).body.data.depends_on).toEqual([
      prerequisite.id,
    ]);
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${downstream.id}`, { depends_on: [] })).status,
    ).toBe(200);
    expect((await f.call('coder', 'POST', `/tasks/${downstream.id}/claim`, {})).status).toBe(200);
  });
  it('removes cancelled frozen tasks from attention while preserving their history', async () => {
    const f = await fixture();
    const obsolete = await f.create({ title: 'Obsolete frozen task' });
    const active = await f.create({ title: 'Active frozen task' });
    for (const task of [obsolete, active])
      expect((await f.call('dax', 'PATCH', `/tasks/${task.id}`, { frozen: true })).status).toBe(
        200,
      );
    const attention = async () =>
      (await f.call('dax', 'GET', '/overview')).body.data.attention.map((task: Task) => task.id);
    expect(await attention()).toEqual([obsolete.id, active.id]);
    expect(
      (
        await f.call('dax', 'POST', `/tasks/${obsolete.id}/transition`, {
          status: 'cancelled',
          reason: 'Replaced by a new plan',
        })
      ).status,
    ).toBe(200);
    expect(await attention()).toEqual([active.id]);
    expect((await f.call('dax', 'GET', `/tasks/${obsolete.id}`)).body.data).toMatchObject({
      status: 'cancelled',
      frozen: true,
      title: 'Obsolete frozen task',
    });
  });
  it('reassigns through valid transitions and supersedes outstanding approvals', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.call('dax', 'PUT', '/settings', {
      gates: [{ from: 'claimed', to: 'in_progress', types: ['test'] }],
    });
    await f.call('coder', 'POST', `/tasks/${task.id}/claim`, {});
    const approval = await f.call('coder', 'POST', `/tasks/${task.id}/approval-requests`, {
      to_status: 'in_progress',
      reason: 'Start work',
    });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${task.id}`, { assignee: 'tester' })).body.data,
    ).toMatchObject({ status: 'claimed', assignee: 'tester' });
    expect(
      f.board.store.get<{ state: string }>(
        'SELECT state FROM approvals WHERE id=?',
        approval.body.data.id,
      )?.state,
    ).toBe('superseded');
    const events = (
      await f.call('dax', 'GET', `/events?task_id=${task.id}&type=task.status_changed`)
    ).body.data;
    expect(events.map((e: { payload: unknown }) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'claimed', to: 'open' }),
        expect.objectContaining({ from: 'open', to: 'claimed' }),
      ]),
    );
    await f.call('dax', 'POST', `/tasks/${task.id}/transition`, {
      status: 'in_progress',
      reason: 'Approved',
    });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${task.id}`, { assignee: 'coder' })).body.data.status,
    ).toBe('claimed');
    const draft = await f.create({ draft: true });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${draft.id}`, { assignee: 'tester' })).body.error.code,
    ).toBe('cannot_reassign');
  });
  it('serves other requests during Git verification and rejects a stale submission', async () => {
    const started = Promise.withResolvers<void>();
    const verification = Promise.withResolvers<void>();
    const f = await fixture({
      verifyCommit: () => {
        started.resolve();
        return verification.promise;
      },
    });
    const task = await f.create({ type: 'bug' });
    await f.start(task);
    const pending = f.call('coder', 'POST', `/tasks/${task.id}/submit`, {
      summary: 'Ready',
      artifacts: [{ kind: 'commit', ref: 'a'.repeat(40) }],
    });
    await started.promise;
    try {
      expect((await f.call('tester', 'GET', '/whoami')).status).toBe(200);
      expect((await f.call('dax', 'PATCH', `/tasks/${task.id}`, { frozen: true })).status).toBe(
        200,
      );
    } finally {
      verification.resolve();
    }
    expect((await pending).body.error.code).toBe('task_changed');
    expect((await f.call('dax', 'GET', `/tasks/${task.id}`)).body.data.status).toBe('in_progress');
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .task_id,
    ).toBe(task.id);
  });
  it('reports completion duration and rejection rate for the assignee', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.start(task);
    f.advance(5 * 60000);
    await f.call('coder', 'POST', `/tasks/${task.id}/submit`, { summary: 'Ready' });
    await f.call('tester', 'POST', `/tasks/${task.id}/review`, {
      verdict: 'changes_requested',
      comments: 'Fix',
    });
    await f.call('coder', 'PATCH', `/tasks/${task.id}`, { status: 'in_progress' });
    f.advance(5 * 60000);
    await f.call('coder', 'POST', `/tasks/${task.id}/submit`, { summary: 'Revised' });
    await f.call('tester', 'POST', `/tasks/${task.id}/review`, {
      verdict: 'approve',
      comments: 'Pass',
    });
    const coder = (await f.call('dax', 'GET', '/participants')).body.data.find(
      (p: { handle: string }) => p.handle === 'coder',
    );
    expect(coder.statistics).toMatchObject({
      completed: 1,
      reviews: 2,
      rejections: 1,
      rejection_rate: 0.5,
    });
    expect(coder.statistics.average_completion_ms).toBeCloseTo(10 * 60000, 0);
  });
  it('allows exactly one concurrent claim, with a useful losing response', async () => {
    const f = await fixture();
    const task = await f.create({ role_hint: 'implementer' });
    const results = await Promise.all(
      ['coder', 'coder2'].map((h) => f.call(h, 'POST', `/tasks/${task.id}/claim`, {})),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('already_claimed');
  });
  it('enforces creation roles and prevents bypassing publication and completion gates', async () => {
    const f = await fixture();
    expect(
      (await f.call('coder', 'POST', '/tasks', { title: 'Code', type: 'implement', draft: true }))
        .status,
    ).toBe(403);
    expect(
      (await f.call('planner', 'POST', '/tasks', { title: 'Code', type: 'implement' })).body.error
        .code,
    ).toBe('approval_required');
    const task = (
      await f.call('planner', 'POST', '/tasks', { title: 'Code', type: 'implement', draft: true })
    ).body.data;
    expect((await f.call('planner', 'PATCH', `/tasks/${task.id}`, { status: 'open' })).status).toBe(
      403,
    );
    const request = await f.call('planner', 'POST', `/tasks/${task.id}/approval-requests`, {
      to_status: 'open',
      reason: 'Ready',
    });
    expect(request.status).toBe(200);
    expect((await f.call('sam', 'GET', '/inbox')).body.data).toHaveLength(1);
    expect(
      (
        await f.call('planner', 'POST', `/tasks/${task.id}/transition`, {
          status: 'open',
          reason: 'Override',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call('dax', 'POST', `/tasks/${task.id}/transition`, {
          status: 'open',
          reason: 'Approved',
        })
      ).status,
    ).toBe(200);
    expect((await f.call('dax', 'GET', '/approvals')).body.data).toHaveLength(0);
    await f.call('dax', 'PATCH', `/tasks/${task.id}`, { repository: f.repository });
    await f.start(task);
    expect((await f.call('coder', 'PATCH', `/tasks/${task.id}`, { status: 'done' })).status).toBe(
      400,
    );
    expect(
      (
        await f.call('coder', 'POST', `/tasks/${task.id}/submit`, {
          summary: 'Done',
          artifacts: [{ kind: 'commit', ref: 'a'.repeat(40) }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call('tester', 'POST', `/tasks/${task.id}/review`, {
          verdict: 'approve',
          comments: 'Pass',
        })
      ).body.error.code,
    ).toBe('approval_required');
    expect(
      (
        await f.call('tester', 'POST', `/tasks/${task.id}/approval-requests`, {
          to_status: 'done',
          reason: 'Tests passed; final approval needs a human',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call('dax', 'POST', `/tasks/${task.id}/review`, {
          verdict: 'approve',
          comments: 'Accepted',
        })
      ).body.data.status,
    ).toBe('done');
  });
  it('serializes writers, retains locks when blocked or expired, and requires explicit human recovery', async () => {
    const f = await fixture();
    const a = await f.create({ type: 'bug' });
    const b = await f.create({ type: 'bug' });
    await f.start(a);
    await f.call('coder2', 'POST', `/tasks/${b.id}/claim`, {});
    expect(
      (await f.call('coder2', 'PATCH', `/tasks/${b.id}`, { status: 'in_progress' })).body.error
        .code,
    ).toBe('write_lock_held');
    expect(
      (
        await f.call('coder', 'PATCH', `/tasks/${a.id}`, {
          status: 'blocked',
          note: 'Need @planner clarification',
        })
      ).status,
    ).toBe(200);
    f.advance(31 * 60000);
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .task_id,
    ).toBe(a.id);
    expect((await f.call('dax', 'GET', `/tasks/${a.id}`)).body.data.lease_expired_at).toBeNull();
    expect((await f.call('dax', 'GET', `/tasks/${b.id}`)).body.data.status).toBe('open');
    const before = (await f.call('dax', 'GET', '/inbox')).body.data.length;
    f.advance(10000);
    expect((await f.call('dax', 'GET', '/inbox')).body.data.length).toBe(before);
    expect(
      (await f.call('coder', 'POST', `/tasks/${a.id}/release`, { reason: 'Stop' })).body.error.code,
    ).toBe('write_lock_held');
    expect(
      (
        await f.call('dax', 'POST', '/lock/release', {
          repository: f.repository,
          reason: 'Inspected and saved the working tree',
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${a.id}`, { status: 'in_progress' })).body.error.code,
    ).toBe('task_frozen');
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${a.id}`, { frozen: false, assignee: 'coder2' }))
        .status,
    ).toBe(200);
    expect(
      (await f.call('coder2', 'PATCH', `/tasks/${a.id}`, { status: 'in_progress' })).status,
    ).toBe(200);
  });
  it('treats a human as a writer and never lets an agent force-release the lock', async () => {
    const f = await fixture();
    await f.call('dax', 'POST', '/lock/acquire', {
      repository: f.repository,
      reason: 'Manual fix',
    });
    const t = await f.create({ type: 'bug' });
    await f.call('coder', 'POST', `/tasks/${t.id}/claim`, {});
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${t.id}`, { status: 'in_progress' })).status,
    ).toBe(409);
    expect(
      (
        await f.call('coder', 'POST', '/lock/release', {
          repository: f.repository,
          reason: 'Override',
        })
      ).status,
    ).toBe(403);
    await f.call('dax', 'POST', '/lock/release', { repository: f.repository, reason: 'Finished' });
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${t.id}`, { status: 'in_progress' })).status,
    ).toBe(200);
  });
  it('filters claim-next by dependencies, priority and role and limits reserved work', async () => {
    const f = await fixture();
    const dependency = await f.create();
    await f.create({ priority: 'P0', depends_on: [dependency.id], role_hint: 'implementer' });
    await f.create({ priority: 'P0', role_hint: 'tester' });
    const eligible = await f.create({ priority: 'P1', role_hint: 'implementer' });
    expect((await f.call('coder', 'POST', '/tasks/claim-next', {})).body.data.id).toBe(eligible.id);
    expect((await f.call('coder', 'POST', '/tasks/claim-next', {})).body.error.code).toBe(
      'task_limit',
    );
  });
  it('blocks self-review, requires checked acceptance criteria, and escalates repeated rejection', async () => {
    const f = await fixture();
    const t = await f.create({ acceptance_criteria: ['Verified output'] });
    await f.start(t);
    await f.call('coder', 'POST', `/tasks/${t.id}/submit`, { summary: 'Ready' });
    expect(
      (
        await f.call('coder', 'POST', `/tasks/${t.id}/review`, {
          verdict: 'approve',
          comments: 'My own work',
        })
      ).body.error.code,
    ).toBe('self_review');
    expect(
      (
        await f.call('tester', 'POST', `/tasks/${t.id}/review`, {
          verdict: 'approve',
          comments: 'Pass',
        })
      ).body.error.code,
    ).toBe('criteria_incomplete');
    for (let i = 1; i <= 3; i++) {
      const result = await f.call('tester', 'POST', `/tasks/${t.id}/review`, {
        verdict: 'changes_requested',
        comments: 'Output differs',
      });
      expect(result.body.data.attempt).toBe(i);
      if (i < 3) {
        await f.call('coder', 'PATCH', `/tasks/${t.id}`, { status: 'in_progress' });
        await f.call('coder', 'POST', `/tasks/${t.id}/submit`, { summary: 'Revised' });
      } else expect(result.body.data.status).toBe('blocked');
    }
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${t.id}`, { status: 'in_progress' })).body.error.code,
    ).toBe('attempt_limit');
    f.advance(31 * 60000);
    expect((await f.call('dax', 'GET', `/tasks/${t.id}`)).body.data).toMatchObject({
      status: 'blocked',
      assignee: 'coder',
      attempt: 3,
    });
    expect(
      (await f.call('dax', 'GET', '/inbox')).body.data.some((n: { message: { body: string } }) =>
        n.message.body.includes('返工上限'),
      ),
    ).toBe(true);
    await f.call('dax', 'POST', `/tasks/${t.id}/release`, { reason: 'Keep for manual follow-up' });
    expect((await f.call('coder', 'POST', `/tasks/${t.id}/claim`, {})).body.error.code).toBe(
      'attempt_limit',
    );
    const next = await f.create();
    expect((await f.call('coder', 'POST', '/tasks/claim-next', {})).body.data.id).toBe(next.id);
  });
  it('rolls back all fields, messages and audit events when one part of a mutation fails', async () => {
    const f = await fixture();
    const t = await f.create();
    await f.start(t);
    await f.call('coder', 'POST', `/tasks/${t.id}/submit`, {
      summary: 'Ready for independent review',
    });
    const before = (await f.call('dax', 'GET', '/events')).body.data.length;
    const update = await f.call('dax', 'PATCH', `/tasks/${t.id}`, {
      title: 'Changed',
      criteria_check: [{ id: 999, checked: true }],
      note: 'This must not persist',
    });
    expect(update.status).toBe(400);
    expect((await f.call('dax', 'GET', `/tasks/${t.id}`)).body.data.title).toBe('Task');
    expect((await f.call('dax', 'GET', '/events')).body.data).toHaveLength(before);
  });
  it('validates Git HEAD and a genuinely clean worktree, preserving the lock on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-git-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    git('init');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Baton Test');
    await writeFile(join(dir, 'code.ts'), 'export const value = 1;\n');
    git('add', 'code.ts');
    git('commit', '-m', 'Initial fixture');
    const sha = git('rev-parse', 'HEAD').trim();
    const f = await fixture({ realGit: true, repository: dir });
    const t = await f.create({ type: 'bug' });
    await f.start(t);
    await writeFile(join(dir, 'code.ts'), 'export const value = 2;\n');
    const submit = () =>
      f.call('coder', 'POST', `/tasks/${t.id}/submit`, {
        summary: 'Ready',
        artifacts: [{ kind: 'commit', ref: sha }],
      });
    expect((await submit()).body.error.code).toBe('dirty_worktree');
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .task_id,
    ).toBe(t.id);
    await writeFile(join(dir, 'code.ts'), 'export const value = 1;\n');
    expect((await submit()).status).toBe(200);
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .holder,
    ).toBeNull();
  });
});

describe('repositories selected per task', () => {
  it('allows unbound plans and requires an explicit repository before code work starts', async () => {
    const f = await fixture();
    const plan = await f.create({ type: 'plan', repository: undefined });
    expect(plan.repository).toBeNull();
    await f.start(plan, 'planner');
    const task = await f.create({ type: 'bug', repository: undefined });
    await f.call('coder', 'POST', `/tasks/${task.id}/claim`, {});
    const before = f.board.eventCursor();
    expect(
      (await f.call('coder', 'PATCH', `/tasks/${task.id}`, { status: 'in_progress' })).body.error
        .code,
    ).toBe('repository_required');
    expect(f.board.eventCursor()).toBe(before);
    expect(
      (
        await f.call('coder', 'PATCH', `/tasks/${task.id}`, {
          repository: f.repository,
          status: 'in_progress',
        })
      ).body.data,
    ).toMatchObject({ repository: f.repository, status: 'in_progress' });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${task.id}`, { repository: resolve('/other') })).body
        .error.code,
    ).toBe('write_lock_held');
    await f.call('dax', 'POST', '/lock/release', {
      repository: f.repository,
      reason: 'Preserved changes',
    });
    expect(
      (await f.call('dax', 'PATCH', `/tasks/${task.id}`, { repository: resolve('/other') })).body
        .error.code,
    ).toBe('repository_locked');
  });

  it('isolates real repository locks and Git verification while canonicalizing subdirectories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-multiple-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const repos = [join(directory, 'backend'), join(directory, 'frontend')];
    const commits: string[] = [];
    for (const repo of repos) {
      await mkdir(join(repo, 'src'), { recursive: true });
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
      git('init', '--quiet');
      git('config', 'user.name', 'Baton Test');
      git('config', 'user.email', 'test@example.invalid');
      await writeFile(join(repo, 'src', 'app.ts'), `// ${repo}\n`);
      git('add', '.');
      git('commit', '--quiet', '-m', 'Initial version');
      commits.push(git('rev-parse', 'HEAD').trim());
    }
    const f = await fixture({ realGit: true });
    const roots = await Promise.all(repos.map(resolveRepository));
    const parent = await f.create({ type: 'plan', repository: undefined });
    const a = await f.create({
      type: 'bug',
      repository: join(repos[0]!, 'src'),
      parent_id: parent.id,
    });
    const b = await f.create({ type: 'bug', repository: repos[1], parent_id: parent.id });
    const same = await f.create({ type: 'bug', repository: repos[0] });
    expect(a.repository).toBe(roots[0]);
    await Promise.all([f.start(a), f.start(b, 'coder2')]);
    expect((await f.call('dax', 'GET', '/overview')).body.data.locks).toHaveLength(2);
    await f.call('tester', 'POST', `/tasks/${same.id}/claim`, {});
    expect(
      (await f.call('tester', 'PATCH', `/tasks/${same.id}`, { status: 'in_progress' })).body.error
        .code,
    ).toBe('write_lock_held');
    const wrong = await f.call('coder', 'POST', `/tasks/${a.id}/submit`, {
      summary: 'Wrong repository',
      artifacts: [{ kind: 'commit', ref: commits[1] }],
    });
    expect(wrong.body.error.code).toBe('git_verification_failed');
    expect(f.board.lock(roots[0]!).task_id).toBe(a.id);
    expect(
      (
        await f.call('coder', 'POST', `/tasks/${a.id}/submit`, {
          summary: 'Backend ready',
          artifacts: [{ kind: 'commit', ref: commits[0] }],
        })
      ).status,
    ).toBe(200);
    expect(f.board.lock(roots[0]!).holder).toBeNull();
    expect(f.board.lock(roots[1]!).task_id).toBe(b.id);
    const filtered = await f.call(
      'dax',
      'GET',
      `/tasks?repository=${encodeURIComponent(join(repos[0]!, 'src'))}`,
    );
    expect(filtered.body.data.map((t: Task) => t.id)).toEqual([a.id, same.id]);
    await f.call('tester', 'POST', `/tasks/${same.id}/release`, { reason: 'Filter next claim' });
    const later = await f.create({ type: 'test', repository: repos[1], depends_on: [a.id] });
    expect(
      (await f.call('tester', 'POST', '/tasks/claim-next', { repository: repos[1] })).body.error
        .code,
    ).toBe('no_eligible_task');
    await f.call('dax', 'POST', `/tasks/${a.id}/review`, {
      verdict: 'approve',
      comments: 'Verified',
    });
    expect(
      (await f.call('tester', 'POST', '/tasks/claim-next', { repository: repos[1] })).body.data.id,
    ).toBe(later.id);
    const before = f.board.eventCursor();
    for (const repository of ['.', directory, join(directory, 'missing')]) {
      expect(
        (await f.call('dax', 'POST', '/tasks', { title: 'Invalid path', type: 'test', repository }))
          .body.error.code,
      ).toBe('invalid_repository');
    }
    expect(f.board.eventCursor()).toBe(before);
  });

  it('preserves a legacy held lock until explicit human recovery and repository selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-v3-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let board: Board | undefined;
    cleanup.push(async () => board?.close());
    const open = () =>
      new Board({
        database: join(directory, 'board.sqlite'),
        config,
        agentToken,
        resolveRepository: async (p) => p,
      });
    board = open();
    const human = board.localHuman();
    const session = board.join(agentToken, { handle: 'coder' }).data.session_id;
    const coder = board.authenticate(agentToken, session);
    const task = (
      await board.execute(human, 'create_task', {
        title: 'Old writer',
        type: 'bug',
        repository: directory,
      })
    ).data as Task;
    await board.execute(coder, 'claim_task', { id: task.id });
    await board.execute(coder, 'update_task', { id: task.id, status: 'in_progress' });
    await board.execute(coder, 'update_task', {
      id: task.id,
      artifacts_add: [{ kind: 'commit', ref: 'a'.repeat(40) }],
    });
    board.store.run('UPDATE tasks SET attempt=1 WHERE id=?', task.id);
    const review = (
      await board.execute(human, 'create_task', {
        title: 'Old review',
        type: 'bug',
        repository: directory,
      })
    ).data as Task;
    await board.execute(human, 'update_task', {
      id: review.id,
      artifacts_add: [{ kind: 'commit', ref: 'b'.repeat(40) }],
    });
    board.store.run("UPDATE tasks SET status='in_review',assignee='coder2' WHERE id=?", review.id);
    const before = board.eventCursor();
    board.store.run(
      'CREATE TABLE write_lock (id INTEGER PRIMARY KEY, holder TEXT, task_id INTEGER, acquired_at TEXT)',
    );
    board.store.run('INSERT INTO write_lock SELECT 1,holder,task_id,acquired_at FROM write_locks');
    board.store.run('DROP TABLE write_locks');
    board.store.run('DROP INDEX tasks_repository');
    board.store.run('ALTER TABLE tasks DROP COLUMN repository');
    board.store.run('DROP TABLE worker_runs');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_at');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_by');
    board.store.run('ALTER TABLE tasks DROP COLUMN workflow_plan');
    board.store.run('PRAGMA user_version=3');
    board.close();
    board = undefined;
    board = open();
    expect(board.authenticate(agentToken, session).handle).toBe('coder');
    expect(board.eventCursor()).toBe(before);
    expect(board.lock(null)).toMatchObject({ holder: 'coder', task_id: task.id });
    expect((await board.execute(human, 'get_task', { id: task.id })).data).toMatchObject({
      repository: null,
      status: 'in_progress',
    });
    await expect(
      board.execute(human, 'acquire_lock', { repository: directory, reason: 'Other work' }),
    ).rejects.toMatchObject({ code: 'legacy_write_lock' });
    await board.execute(human, 'release_lock', {
      repository: null,
      reason: 'Checked original workspace',
    });
    expect(
      (
        await board.execute(human, 'update_task', {
          id: task.id,
          repository: directory,
          frozen: false,
          status: 'in_progress',
        })
      ).data,
    ).toMatchObject({ repository: directory, status: 'in_progress', frozen: false });
    expect(board.lock(null).holder).toBeNull();
    expect(board.lock(directory).task_id).toBe(task.id);
    const recovered = (
      await board.execute(human, 'update_task', { id: review.id, repository: directory })
    ).data as Task;
    expect(recovered).toMatchObject({
      repository: directory,
      status: 'in_review',
      assignee: 'coder2',
    });
    expect(recovered.artifacts[0]?.ref).toBe('b'.repeat(40));
  });
});

describe('messaging, presence, authentication and replay', () => {
  it('paginates recent events and inbox beyond 200 entries and filters questions before limiting', async () => {
    const f = await fixture();
    for (let i = 0; i < 215; i++) {
      expect(
        (
          await f.call('sam', 'POST', '/messages', {
            to: 'dax',
            body: `Message ${i}`,
            kind: i === 212 ? 'question' : 'comment',
          })
        ).status,
      ).toBe(200);
    }
    const recent = (await f.call('dax', 'GET', '/events?order=desc&limit=50')).body.data;
    expect(recent).toHaveLength(50);
    expect(recent[0].id).toBeGreaterThan(recent.at(-1).id);
    const older = (
      await f.call('dax', 'GET', `/events?order=desc&limit=50&before=${recent.at(-1).id}`)
    ).body.data;
    expect(older[0].id).toBeLessThan(recent.at(-1).id);
    expect(
      (await f.call('coder', 'GET', '/events?order=desc&type=message.posted')).body.data,
    ).toHaveLength(0);
    const inbox = (await f.call('dax', 'GET', '/inbox?unread_only=false&order=desc&limit=200')).body
      .data;
    const rest = (
      await f.call(
        'dax',
        'GET',
        `/inbox?unread_only=false&order=desc&limit=200&before=${inbox.at(-1).id}`,
      )
    ).body.data;
    expect(inbox).toHaveLength(200);
    expect(rest).toHaveLength(15);
    expect(new Set([...inbox, ...rest].map((n: { id: number }) => n.id)).size).toBe(215);
    expect(
      (await f.call('dax', 'GET', '/inbox?kind=question&limit=5')).body.data[0].message.body,
    ).toBe('Message 212');
  });
  it('migrates old databases, preserves freezes and dynamic sessions, and reconciles configured profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-config-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'board.sqlite');
    let active: Board | undefined;
    cleanup.push(async () => active?.close());
    const open = (next: BoardConfig) => {
      active?.close();
      active = undefined;
      active = new Board({ database, config: next, agentToken });
      return active;
    };
    let board = open(config);
    board.store.run(
      "UPDATE participants SET token_hash=? WHERE handle='dax'",
      hashToken(token('dax')),
    );
    const oldSession = board.join(agentToken, { handle: 'coder' }).data.session_id;
    board.store.run("UPDATE participants SET frozen=1 WHERE kind='human'");
    board.store.run('ALTER TABLE participants DROP COLUMN enabled');
    board.store.run('ALTER TABLE participants DROP COLUMN managed');
    board.store.run('DROP INDEX tasks_repository');
    board.store.run('ALTER TABLE tasks DROP COLUMN repository');
    board.store.run('DROP TABLE write_locks');
    board.store.run(
      'CREATE TABLE write_lock (id INTEGER PRIMARY KEY, holder TEXT, task_id INTEGER, acquired_at TEXT)',
    );
    board.store.run('INSERT INTO write_lock(id) VALUES(1)');
    board.store.run('DROP TABLE worker_runs');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_at');
    board.store.run('ALTER TABLE tasks DROP COLUMN plan_approved_by');
    board.store.run('ALTER TABLE tasks DROP COLUMN workflow_plan');
    board.store.run('PRAGMA user_version=1');
    board.close();
    active = undefined;
    board = open(config);
    expect(board.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(5);
    expect(() => board.authenticate(agentToken, oldSession)).toThrow();
    expect(board.localHuman().frozen).toBe(false);
    expect(() => board.authenticate(token('dax'))).toThrow();
    expect(
      board.store.get<{ token_hash: string }>(
        "SELECT token_hash FROM participants WHERE handle='dax'",
      )!.token_hash,
    ).toBe('human:dax');
    await board.execute(board.localHuman(), 'freeze_participant', {
      handle: 'coder',
      frozen: true,
      reason: 'Intentional pause',
    });
    const dynamic = board.join(agentToken, { handle: 'new_tester', role: 'tester' }).data
      .session_id;
    const removed = structuredClone(config);
    delete removed.humans.dax;
    delete removed.agents.coder2;
    board = open(removed);
    expect(() => board.localHuman('dax')).toThrow();
    expect(board.localHuman().handle).toBe('sam');
    expect(() => board.join(agentToken, { handle: 'coder2', role: 'implementer' })).toThrow();
    expect(board.authenticate(agentToken, dynamic).handle).toBe('new_tester');
    const changed = structuredClone(config);
    changed.agents.renamed = changed.agents.coder2!;
    delete changed.agents.coder2;
    changed.humans.dax!.display_name = 'Updated local user';
    board = open(changed);
    expect(board.localHuman()).toMatchObject({ handle: 'dax', display_name: 'Updated local user' });
    expect(() => board.join(agentToken, { handle: 'coder' })).toThrow(/paused/);
    expect(board.join(agentToken, { handle: 'renamed' }).data.participant.role).toBe('implementer');
    expect(board.authenticate(agentToken, dynamic).handle).toBe('new_tester');
    expect(() => board.authenticate(hashToken(token('dax')))).toThrow();
    expect(() => board.authenticate('coder-'.repeat(6))).toThrow();
  });
  it('resumes existing work without binding participants to a tool or model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-role-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let board: Board | undefined;
    cleanup.push(async () => board?.close());
    const legacy = {
      ...config,
      agents: {
        ...config.agents,
        coder: { role: 'implementer', runtime: 'claude-code', model: 'opus' },
      },
      humans: { dax: { display_name: 'Dax', runtime: 'browser', model: 'unused' } },
    };
    const open = () =>
      new Board({
        database: join(directory, 'board.sqlite'),
        resolveRepository: async (path) => path,
        config: configSchema.parse(legacy),
        agentToken,
      });
    board = open();
    // Existing databases can still contain these historical display fields.
    board.store.run(
      "UPDATE participants SET runtime='claude-code',model='opus' WHERE handle='coder'",
    );
    const session = board.join(agentToken, { handle: 'coder' }).data.session_id;
    const task = (
      await board.execute(board.localHuman(), 'create_task', {
        title: 'Continue the same coding task',
        repository: directory,
        type: 'implement',
      })
    ).data as Task;
    await board.execute(board.authenticate(agentToken, session), 'claim_task', { id: task.id });
    await board.execute(board.authenticate(agentToken, session), 'update_task', {
      id: task.id,
      status: 'in_progress',
    });
    const cursor = board.eventCursor();
    board.close();
    board = undefined;
    legacy.agents.coder.runtime = 'codex';
    legacy.agents.coder.model = 'gpt';
    board = open();
    const actor = board.authenticate(agentToken, session);
    expect(actor).toMatchObject({ handle: 'coder', role: 'implementer' });
    expect(actor).not.toHaveProperty('runtime');
    expect(actor).not.toHaveProperty('model');
    expect(board.eventCursor()).toBe(cursor);
    const resumed = board.join(agentToken, { handle: 'coder', role: 'implementer' }).data;
    expect(resumed.tasks).toEqual([
      expect.objectContaining({ id: task.id, status: 'in_progress', assignee: 'coder' }),
    ]);
    expect((await board.execute(actor, 'get_lock', { repository: directory })).data).toMatchObject({
      holder: 'coder',
      task_id: task.id,
    });
    const participants = (await board.execute(board.localHuman(), 'list_participants', {})).data;
    expect(JSON.stringify(participants)).not.toMatch(/"runtime"|"model"/);
    expect(() => board.join(agentToken, { handle: 'coder', role: 'tester' })).toThrow(
      /different role/,
    );
  });
  it('resolves special mentions, deduplicates inbox delivery and resolves answered questions', async () => {
    const f = await fixture();
    await f.call('coder', 'GET', '/whoami');
    const t = await f.create();
    await f.call('coder', 'POST', `/tasks/${t.id}/claim`, {});
    const post = await f.call('planner', 'POST', '/messages', {
      task_id: t.id,
      kind: 'question',
      body: '@assignee @role:implementer @human clarify this',
      mentions: ['coder'],
    });
    expect(post.status).toBe(200);
    const inbox = (await f.call('coder', 'GET', '/inbox')).body.data;
    expect(inbox).toHaveLength(1);
    const reply = await f.call('coder', 'POST', '/messages', {
      task_id: t.id,
      reply_to: post.body.data.id,
      body: 'Here is the answer',
    });
    expect(reply.body.unread).toBe(0);
    expect((await f.call('coder', 'GET', '/inbox?unread_only=false')).body.data[0].state).toBe(
      'resolved',
    );
    expect((await f.call('sam', 'GET', '/inbox')).body.data).toHaveLength(1);
  });
  it('isolates private messages, event replay and inbox mutations even from other humans', async () => {
    const f = await fixture();
    await f.call('coder', 'POST', '/messages', { to: 'dax', body: 'private secret' });
    expect((await f.call('sam', 'GET', '/messages?channel=dm%3Acoder%3Adax')).status).toBe(403);
    const daxEvents = (await f.call('dax', 'GET', '/events')).body.data;
    expect(JSON.stringify(daxEvents)).toContain('private secret');
    expect(JSON.stringify((await f.call('sam', 'GET', '/events')).body)).not.toContain(
      'private secret',
    );
    const inbox = (await f.call('dax', 'GET', '/inbox')).body.data;
    expect((await f.call('sam', 'POST', '/inbox/mark', { ids: [inbox[0].id] })).status).toBe(404);
    expect(
      (await f.call('coder', 'POST', '/messages', { to: 'dax', body: '@sam take a look' })).body
        .error.code,
    ).toBe('private_mention');
  });
  it('freezes every agent write while retaining read access and the write lock', async () => {
    const f = await fixture();
    const t = await f.create({ type: 'bug' });
    await f.start(t);
    await f.call('dax', 'POST', '/participants/coder/freeze', {
      frozen: true,
      reason: 'Pause here',
    });
    expect(
      (await f.call('coder', 'POST', '/messages', { channel: 'general', body: 'Keep going' })).body
        .error.code,
    ).toBe('agent_frozen');
    expect((await f.call('coder', 'POST', '/agents/join', { handle: 'coder' })).status).toBe(403);
    expect((await f.call('coder', 'GET', '/inbox')).status).toBe(200);
    expect(
      (await f.call('dax', 'GET', `/lock?repository=${encodeURIComponent(f.repository)}`)).body.data
        .holder,
    ).toBe('coder');
    await f.call('dax', 'POST', '/participants/coder/freeze', {
      frozen: false,
      reason: 'Continue',
    });
    expect((await f.call('coder', 'PATCH', `/tasks/${t.id}`, { note: 'Resumed' })).status).toBe(
      200,
    );
  });
  it('leaves one logical session without invalidating another session or its task', async () => {
    const f = await fixture();
    const a = f.board.join(agentToken, { handle: 'tester' }).data.session_id;
    const b = f.board.join(agentToken, { handle: 'tester' }).data.session_id;
    const task = await f.create({ role_hint: 'tester' });
    await f.board.execute(f.board.authenticate(agentToken, a), 'claim_task', { id: task.id });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/agents/leave',
      headers: { authorization: `Bearer ${agentToken}`, 'x-baton-session': a },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(() => f.board.authenticate(agentToken, a)).toThrow();
    expect(f.board.authenticate(agentToken, b).status).toBe('online');
    expect((await f.call('dax', 'GET', `/tasks/${task.id}`)).body.data.assignee).toBe('tester');
  });
  it('rejects implicit human writes, cross-origin requests, preflights and remote hosts', async () => {
    const f = await fixture();
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/tasks', payload: {} })).statusCode,
    ).toBe(401);
    expect(
      (await f.call('coder', 'POST', '/agents/join', { handle: 'intruder', role: 'human' })).status,
    ).toBe(400);
    const local = { 'x-baton-client': 'local', host: '127.0.0.1:4100' };
    for (const origin of [
      'https://example.com',
      'http://127.0.0.1:4101',
      'http://localhost:4100',
      'https://127.0.0.1:4100',
      'null',
      'invalid',
    ]) {
      const denied = await f.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { ...local, origin },
        payload: { title: 'Cross-origin write', type: 'test' },
      });
      expect(denied.statusCode, origin).toBe(403);
    }
    const preflight = await f.app.inject({
      method: 'OPTIONS',
      url: '/api/tasks',
      headers: {
        ...local,
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-baton-client',
      },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await f.app.inject({ url: '/api/whoami', headers: { ...local, host: 'evil.example' } }))
        .statusCode,
    ).toBe(403);
    const sameOrigin = await f.app.inject({
      url: '/api/whoami',
      headers: { ...local, origin: 'http://127.0.0.1:4100' },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(sameOrigin.headers['x-frame-options']).toBe('DENY');
    expect((await f.call('dax', 'GET', '/tasks')).body.data).toHaveLength(0);
    const response = await f.call('dax', 'GET', '/participants');
    expect(JSON.stringify(response)).not.toContain('token');
  });
  it('wakes long polling on a new mention, replays SSE after a cursor, and cleans up connections', async () => {
    const f = await fixture();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    const waiting = fetch(`${address}/api/inbox/wait?since=0&timeout=3`, {
      headers: f.headers('coder'),
      signal: abort.signal,
    });
    await f.call('planner', 'POST', '/messages', {
      channel: 'general',
      body: '@coder please review',
    });
    const result = (await (await waiting).json()) as Envelope<unknown[]>;
    expect(result.data).toHaveLength(1);
    const events = (await f.call('dax', 'GET', '/events')).body.data;
    const cursor = events.at(-1).id;
    await f.call('planner', 'POST', '/messages', { channel: 'general', body: 'Catch this event' });
    const response = await fetch(`${address}/api/events/stream`, {
      headers: { ...f.headers('dax'), 'Last-Event-ID': String(cursor) },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    let output = '';
    while (!output.includes('Catch this event')) {
      const part = await reader.read();
      output += new TextDecoder().decode(part.value);
    }
    expect(output).not.toContain('please review');
    abort.abort();
    await reader.cancel().catch(() => {});
  });
  it('persists tasks, mentions and audit events across server restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-db-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const database = join(dir, 'board.sqlite');
    const f = await fixture({ database });
    const t = await f.create({ title: 'Persistent task' });
    await f.call('planner', 'POST', '/messages', { task_id: t.id, body: '@coder remember this' });
    const close = cleanup.pop()!;
    await close();
    const again = await fixture({ database });
    expect((await again.call('dax', 'GET', `/tasks/${t.id}`)).body.data.title).toBe(
      'Persistent task',
    );
    expect((await again.call('coder', 'GET', '/inbox')).body.data).toHaveLength(1);
    expect((await again.call('dax', 'GET', '/events')).body.data.length).toBeGreaterThan(1);
  });
});
