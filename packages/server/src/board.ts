import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import {
  operations,
  schemas,
  settingsSchema,
  transitions,
  isGated,
  type Approval,
  type Artifact,
  type ArtifactInput,
  type BoardConfig,
  type BoardEvent,
  type Channel,
  type Criterion,
  type Envelope,
  type Identity,
  type AgentSession,
  type Input,
  type Mention,
  type Message,
  type Operation,
  type Overview,
  type Parsed,
  type Participant,
  type Settings,
  type Task,
  type TaskStatus,
  type TaskSummary,
  type WriteLock,
  type WorkerAssignment,
  type Evidence,
  type Handoff,
  type PreparedEvidence,
  type TaskRun,
  type AttentionItem,
  type AttentionQueue,
} from '@baton/shared';
import { Store } from './database.js';
import { requireCondition as check } from './errors.js';
import { resolveRepository, verifyCommit } from './git.js';
import { insideDirectory, prepareEvidence, submissionEvidence } from './evidence.js';

type ParticipantRow = Omit<Participant, 'frozen'> & { frozen: number };
type TaskRow = Omit<TaskSummary, 'frozen' | 'writes_code' | 'workflow_plan'> & {
  description: string;
  reviewer: string | null;
  context: string;
  frozen: number;
  writes_code: number;
  workflow_plan: number;
};
type EventRow = Omit<BoardEvent, 'payload'> & { payload: string; audience: string | null };
type WorkerRun = {
  id: string;
  task_id: number;
  handle: string;
  coordinator: string;
  mode: WorkerAssignment['mode'];
  state: WorkerAssignment['state'];
  commit_sha: string | null;
  submitted_commit_sha: string | null;
  evidence_directory: string | null;
  evidence: string;
  lease_until: string;
  created_at: string;
};
// NULL uses the configured name; an empty override explicitly clears the nickname.
const participantColumns =
  "handle,kind,role,NULLIF(COALESCE(display_name_override,display_name),'') AS display_name,status,status_note,frozen,last_seen_at";
const activeStatuses = ['claimed', 'in_progress', 'blocked', 'changes_requested'];
const leasedStatuses = ['claimed', 'in_progress', 'changes_requested'];
const terminal = (t: TaskSummary) => ['done', 'cancelled'].includes(t.status);
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Board {
  readonly changes = new EventEmitter();
  readonly store: Store;
  private readonly evidenceRoot: string;
  constructor(
    private readonly options: {
      database: string;
      config: BoardConfig;
      agentToken: string;
      now?: () => number;
      verifyCommit?: (repository: string, sha: string) => void | Promise<void>;
      resolveRepository?: (repository: string) => Promise<string>;
      evidenceDirectory?: string;
    },
  ) {
    this.store = new Store(options.database);
    this.evidenceRoot = resolve(
      options.evidenceDirectory ??
        join(
          options.database === ':memory:' ? tmpdir() : homedir(),
          '.agent-board',
          'evidence',
          options.database === ':memory:'
            ? randomUUID()
            : hashToken(resolve(options.database)).slice(0, 16),
        ),
    );
    this.changes.setMaxListeners(0);
    this.store.transaction(() => {
      // Revoke legacy credentials and reconcile configured identities. The old column is
      // retained for database compatibility; participant identities no longer hold secrets.
      this.store.run(
        "UPDATE participants SET token_hash='revoked:'||handle,enabled=0 WHERE managed=1",
      );
      const enabled = new Set<string>();
      for (const [kind, profiles] of [
        ['agent', options.config.agents],
        ['human', options.config.humans],
      ] as const) {
        for (const [handle, profile] of Object.entries(profiles)) {
          enabled.add(handle);
          const previous = this.store.get<{ kind: string }>(
            'SELECT kind FROM participants WHERE handle=?',
            handle,
          );
          check(
            !previous || previous.kind === kind,
            'identity_kind_changed',
            `@${handle} already exists as ${previous?.kind}.`,
            'Use a new handle for a different participant kind.',
          );
          this.store.run(
            `INSERT INTO participants(handle,kind,role,display_name,token_hash,status,enabled,managed) VALUES(?,?,?,?,?,?,1,1)
            ON CONFLICT(handle) DO UPDATE SET role=excluded.role,display_name=excluded.display_name,token_hash=excluded.token_hash,enabled=1,managed=1,frozen=CASE WHEN excluded.kind='human' THEN 0 ELSE participants.frozen END,status=CASE WHEN excluded.kind='human' THEN 'online' ELSE participants.status END`,
            handle,
            kind,
            profile.role ?? null,
            profile.display_name ?? null,
            `${kind}:${handle}`,
            kind === 'human' ? 'online' : 'offline',
          );
        }
      }
      for (const p of this.store.all<{ handle: string }>(
        'SELECT handle FROM participants WHERE managed=1',
      )) {
        if (!enabled.has(p.handle))
          this.store.run(
            "UPDATE participants SET token_hash=?,enabled=0,status='offline' WHERE handle=?",
            `revoked:${p.handle}`,
            p.handle,
          );
      }
      this.store.run(
        'DELETE FROM sessions WHERE handle IN (SELECT handle FROM participants WHERE enabled=0)',
      );
      this.store.run(
        "INSERT OR IGNORE INTO settings(key,value) VALUES('policy',?)",
        JSON.stringify(settingsSchema.parse({})),
      );
      const saved = JSON.parse(
        this.store.get<{ value: string }>("SELECT value FROM settings WHERE key='policy'")!.value,
      ) as Record<string, unknown>;
      if (saved.approval_mode === undefined) {
        // Adopt the new default only for the former stock policy; preserve custom policies.
        const defaults = settingsSchema.parse({});
        saved.approval_mode =
          JSON.stringify(saved.gates) === JSON.stringify(defaults.gates) ? 'plan' : 'custom';
        const roles = saved.roles as Record<string, string[]> | undefined;
        if (
          roles?.planner &&
          JSON.stringify([...roles.planner].sort()) ===
            JSON.stringify(defaults.roles.planner!.filter((type) => type !== 'merge').sort())
        )
          roles.planner.push('merge');
        this.store.run(
          "UPDATE settings SET value=? WHERE key='policy'",
          JSON.stringify(settingsSchema.parse(saved)),
        );
        this.event(null, 'settings.migrated', null, { approval_mode: saved.approval_mode });
      }
    });
  }
  now(): number {
    return this.options.now?.() ?? Date.now();
  }
  timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private lease(): string {
    return new Date(this.now() + this.settings().lease_minutes * 60000).toISOString();
  }
  close(): void {
    this.store.close();
    this.changes.removeAllListeners();
  }
  private agentAccess(token: string | undefined): void {
    check(
      token && hashToken(token) === hashToken(this.options.agentToken),
      'unauthorized',
      'Local agent access is required.',
      'Use the Baton MCP or CLI; they read local access automatically.',
      401,
    );
  }
  join(token: string | undefined, input: unknown): Envelope<AgentSession> {
    this.agentAccess(token);
    const p = schemas.join.parse(input);
    return this.transaction(() => {
      const existing = this.store.get<ParticipantRow & { enabled: number }>(
        `SELECT ${participantColumns},enabled FROM participants WHERE handle=?`,
        p.handle,
      );
      check(
        !existing || existing.kind === 'agent',
        'agent_required',
        'This handle belongs to a human.',
        'Choose an agent handle; joining cannot grant human permissions.',
        403,
      );
      check(
        !existing || existing.enabled,
        'participant_disabled',
        'This participant was removed by configuration.',
        'Ask the human to restore the profile, or use your own handle.',
        403,
      );
      const role = p.role ?? existing?.role;
      check(
        role && Object.hasOwn(this.settings().roles, role),
        'invalid_role',
        'Choose a configured agent role.',
        'Use planner, implementer, tester, or another configured agent role.',
        400,
      );
      check(
        !existing || existing.role === role,
        'role_conflict',
        'This handle already has a different role.',
        'Keep its existing role or choose a different handle.',
        409,
      );
      if (existing) this.writable(this.publicParticipant(existing));
      else
        this.store.run(
          `INSERT INTO participants(handle,kind,role,token_hash,status,enabled,managed) VALUES(?,'agent',?,?,'offline',1,0)`,
          p.handle,
          role,
          `agent:${p.handle}`,
        );
      const id = randomUUID();
      this.store.run(
        'INSERT INTO sessions(id,handle,last_seen_at) VALUES(?,?,?)',
        id,
        p.handle,
        this.timestamp(),
      );
      this.store.run(
        "UPDATE participants SET status='online',last_seen_at=? WHERE handle=?",
        this.timestamp(),
        p.handle,
      );
      this.event(p.handle, 'agent.joined', null, { handle: p.handle, session_id: id, role });
      const actor = this.participant(p.handle);
      return {
        data: {
          session_id: id,
          participant: actor,
          tasks: this.listTasks(actor, { mine: true, limit: 200, offset: 0 }).filter(
            (t) => !terminal(t),
          ),
          unread: this.unread(p.handle),
        },
        unread: this.unread(p.handle),
      };
    });
  }
  authenticate(token: string | undefined, sessionId?: string): Participant {
    this.agentAccess(token);
    check(
      sessionId,
      'session_required',
      'A Baton session ID is required.',
      'Call join once, then include its session_id in every request.',
      401,
    );
    const session = this.store.get<{ handle: string }>(
      'SELECT handle FROM sessions WHERE id=?',
      sessionId,
    );
    check(
      session,
      'session_not_found',
      'This Baton session does not exist or has ended.',
      'Join again only if your previous session has ended.',
      401,
    );
    const actor = this.participant(session.handle);
    check(
      actor.kind === 'agent',
      'agent_required',
      'An agent session cannot represent a human.',
      'Open the dashboard for human operations.',
      403,
    );
    // Logical sessions survive idle periods; activity is updated by requests, not MCP process heartbeats.
    this.store.run('UPDATE sessions SET last_seen_at=? WHERE id=?', this.timestamp(), sessionId);
    this.store.run(
      "UPDATE participants SET last_seen_at=?,status=CASE WHEN status='offline' THEN 'online' ELSE status END WHERE handle=?",
      this.timestamp(),
      actor.handle,
    );
    return this.participant(actor.handle);
  }
  /** Trusted local UI/CLI attribution, not authentication against other local processes. */
  localHuman(handle = Object.keys(this.options.config.humans)[0]!): Participant {
    const actor = this.participant(handle);
    this.human(actor);
    return actor;
  }
  private publicParticipant(p: ParticipantRow): Participant {
    let status = p.status;
    if (p.kind === 'agent' && (!p.last_seen_at || this.now() - Date.parse(p.last_seen_at) >= 90000))
      status = 'offline';
    else if (
      status !== 'offline' &&
      status !== 'waiting' &&
      this.store.get(
        "SELECT id FROM tasks WHERE assignee=? AND status='in_progress' LIMIT 1",
        p.handle,
      )
    )
      status = 'working';
    return { ...p, frozen: Boolean(p.frozen), status };
  }
  private participant(handle: string, includeDisabled = false): Participant {
    const p = this.store.get<ParticipantRow>(
      `SELECT ${participantColumns} FROM participants WHERE handle=? ${includeDisabled ? '' : 'AND enabled=1'}`,
      handle,
    );
    check(
      p,
      'participant_not_found',
      `@${handle} does not exist.`,
      'Use list_participants to find a valid handle.',
      404,
    );
    return this.publicParticipant(p);
  }
  private human(actor: Participant): void {
    check(
      actor.kind === 'human',
      'human_required',
      'This operation requires a human participant.',
      'Use request_approval or mention @human for intervention.',
      403,
    );
  }
  private writable(actor: Participant, task?: TaskSummary): void {
    check(
      !actor.frozen,
      'agent_frozen',
      'You have been paused. Please wait for @human instructions.',
      'Read your inbox; a human must resume your participant.',
      403,
    );
    check(
      !task?.frozen || actor.kind === 'human',
      'task_frozen',
      `T-${task?.id} has been frozen.`,
      'Ask @human to resume this task.',
      403,
    );
  }
  private owner(actor: Participant, task: TaskSummary): void {
    this.writable(actor, task);
    check(
      actor.kind === 'human' || task.assignee === actor.handle,
      'not_assignee',
      `T-${task.id} is assigned to ${task.assignee ? `@${task.assignee}` : 'nobody'}.`,
      'Claim an open task or ask @human to reassign it.',
      403,
    );
  }
  private taskActor(actor: Participant, task: TaskSummary): void {
    this.writable(actor, task);
    check(
      actor.kind === 'human' ||
        task.assignee === actor.handle ||
        (!task.assignee && task.creator === actor.handle),
      'not_task_actor',
      'Only the task owner or creator may do this.',
      'Post a message to the task owner.',
      403,
    );
  }
  private transaction<T>(fn: () => T): T {
    const before = this.eventCursor();
    const result = this.store.transaction(fn);
    if (this.eventCursor() !== before) this.changes.emit('change');
    return result;
  }
  eventCursor(): number {
    return this.store.get<{ id: number }>('SELECT coalesce(max(id),0) id FROM events')!.id;
  }
  private event(
    actor: string | null,
    type: string,
    taskId: number | null,
    payload: Record<string, unknown>,
    audience: string[] | null = null,
  ): void {
    this.store.run(
      'INSERT INTO events(actor,type,task_id,payload,audience,created_at) VALUES(?,?,?,?,?,?)',
      actor,
      type,
      taskId,
      JSON.stringify(payload),
      audience ? JSON.stringify(audience) : null,
      this.timestamp(),
    );
  }
  settings(): Settings {
    return settingsSchema.parse(
      JSON.parse(
        this.store.get<{ value: string }>("SELECT value FROM settings WHERE key='policy'")!.value,
      ),
    );
  }
  lock(repository: string | null): WriteLock {
    return {
      repository,
      ...(this.store.get<Omit<WriteLock, 'repository'>>(
        'SELECT holder,task_id,acquired_at FROM write_locks WHERE repository=?',
        repository ?? '',
      ) ?? { holder: null, task_id: null, acquired_at: null }),
    };
  }
  private taskLock(task: Pick<TaskSummary, 'id' | 'repository'>): WriteLock {
    // A migrated lock has no known repository. Preserve its ownership until a human inspects it.
    const legacy = this.lock(null);
    return legacy.task_id === task.id ? legacy : this.lock(task.repository);
  }
  private checkLegacyLock(): void {
    check(
      !this.lock(null).holder,
      'legacy_write_lock',
      'A write lock from the previous version has no repository information.',
      'Ask @human to inspect the old working tree and release_lock with repository=null.',
    );
  }
  private task(id: number): Task {
    const row = this.store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', id);
    check(row, 'task_not_found', `T-${id} does not exist.`, 'Use list_tasks to find a task.', 404);
    const criteria = this.store.all<Omit<Criterion, 'checked'> & { checked: number }>(
      'SELECT id,text,checked,checked_by,position FROM acceptance_criteria WHERE task_id=? ORDER BY position',
      id,
    );
    return {
      ...row,
      context: JSON.parse(row.context) as Record<string, unknown>,
      frozen: Boolean(row.frozen),
      writes_code: Boolean(row.writes_code),
      workflow_plan: Boolean(row.workflow_plan),
      depends_on: this.store
        .all<{
          depends_on_id: number;
        }>('SELECT depends_on_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_id', id)
        .map((d) => d.depends_on_id),
      acceptance_criteria: criteria.map((c) => ({ ...c, checked: Boolean(c.checked) })),
      artifacts: this.store.all<Artifact>(
        'SELECT id,kind,ref,label,created_by,created_at FROM artifacts WHERE task_id=? ORDER BY id',
        id,
      ),
      submitted_commit_sha: this.submissionSha(id),
      evidence: this.store
        .all<{
          evidence: string;
        }>('SELECT evidence FROM worker_runs WHERE task_id=? ORDER BY created_at,id', id)
        .flatMap((r) => JSON.parse(r.evidence) as Evidence[]),
      labels: this.store
        .all<{ label: string }>('SELECT label FROM labels WHERE task_id=? ORDER BY label', id)
        .map((l) => l.label),
    };
  }
  private summary(row: TaskRow): TaskSummary {
    const { description: _description, context: _context, ...rest } = row;
    return {
      ...rest,
      writes_code: Boolean(row.writes_code),
      workflow_plan: Boolean(row.workflow_plan),
      frozen: Boolean(row.frozen),
    };
  }
  private listTasks(actor: Participant, input: Parsed<'list_tasks'>): TaskSummary[] {
    const where: string[] = [];
    if (input.active_only) where.push("status NOT IN ('done','cancelled')");
    const params: SQLInputValue[] = [];
    for (const [column, value] of [
      ['status', input.status],
      ['assignee', input.mine ? actor.handle : input.assignee],
      ['role_hint', input.role_hint],
      ['parent_id', input.parent],
      ['repository', input.repository],
      ['type', input.type],
    ] as const) {
      if (value !== undefined) {
        where.push(`${column}=?`);
        params.push(value);
      }
    }
    if (input.search) {
      const query = input.search.replace(/[\\%_]/g, '\\$&');
      where.push("(title LIKE ? ESCAPE '\\' OR id=?)");
      params.push(
        `%${query}%`,
        /^(?:T-)?\d+$/i.test(input.search) ? Number(input.search.replace(/^T-/i, '')) : -1,
      );
    }
    if (input.depends_on !== undefined) {
      where.push('id IN (SELECT task_id FROM task_dependencies WHERE depends_on_id=?)');
      params.push(input.depends_on);
    }
    return this.store
      .all<TaskRow>(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority,id LIMIT ? OFFSET ?`,
        ...params,
        input.limit,
        input.offset,
      )
      .map((t) => this.summary(t));
  }
  private unread(handle: string): number {
    return this.store.get<{ n: number }>(
      "SELECT count(*) n FROM mentions WHERE handle=? AND state='unread'",
      handle,
    )!.n;
  }
  private taskRuns(p: Parsed<'list_task_runs'>): { items: TaskRun[]; total: number } {
    this.task(p.id);
    const rows = this.store.all<WorkerRun>(
      'SELECT * FROM worker_runs WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',
      p.id,
      p.limit,
      p.offset,
    );
    const items = rows.map((run): TaskRun => {
      const end = this.store.get<EventRow>(
        "SELECT * FROM events WHERE task_id=? AND json_extract(payload,'$.run_id')=? AND type IN ('worker.completed','worker.stopped','task.merge_conflict') ORDER BY id DESC LIMIT 1",
        p.id,
        run.id,
      );
      const payload = end ? (JSON.parse(end.payload) as Record<string, unknown>) : {};
      const message = this.store.get<{ body: string }>(
        "SELECT body FROM messages WHERE run_id=? AND task_id=? AND kind IN ('handoff','report','system') ORDER BY id DESC LIMIT 1",
        run.id,
        p.id,
      );
      return {
        run_id: run.id,
        mode: run.mode,
        state: run.state,
        handle: run.handle,
        coordinator: run.coordinator,
        commit_sha: run.commit_sha,
        submitted_commit_sha: run.submitted_commit_sha,
        created_at: run.created_at,
        ended_at: end?.created_at ?? null,
        summary:
          typeof payload.summary === 'string'
            ? payload.summary
            : typeof payload.reason === 'string'
              ? payload.reason
              : (message?.body ?? null),
        outcome:
          payload.verdict === 'approve' || payload.verdict === 'changes_requested'
            ? payload.verdict
            : run.mode === 'implement' && run.state === 'completed'
              ? 'submitted'
              : null,
        evidence: JSON.parse(run.evidence) as Evidence[],
      };
    });
    return {
      items,
      total: this.store.get<{ n: number }>(
        'SELECT count(*) n FROM worker_runs WHERE task_id=?',
        p.id,
      )!.n,
    };
  }
  private attentionQueue(actor: Participant, p: Parsed<'get_attention_queue'>): AttentionQueue {
    this.human(actor);
    const rows = this.store.all<TaskRow>(
      `SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') AND
      (status IN ('blocked','in_review') OR frozen=1 OR lease_expired_at IS NOT NULL OR
       EXISTS(SELECT 1 FROM approvals a WHERE a.task_id=tasks.id AND a.state='pending'))`,
    );
    const impact = (id: number) =>
      this.store.get<{ n: number }>(
        `SELECT count(*) n FROM tasks WHERE status NOT IN ('done','cancelled') AND
      (parent_id=? OR id IN (SELECT task_id FROM task_dependencies WHERE depends_on_id=?))`,
        id,
        id,
      )!.n;
    const items: AttentionItem[] = rows.map((row) => {
      const task = this.task(row.id);
      const handoff = this.handoff(task);
      const approval = this.store.get<Approval>(
        "SELECT * FROM approvals WHERE task_id=? AND state='pending' ORDER BY id LIMIT 1",
        row.id,
      );
      const kind =
        row.frozen || row.lease_expired_at || row.status === 'blocked'
          ? 'blocker'
          : approval
            ? 'approval'
            : 'review';
      const event = this.store.get<EventRow>(
        `SELECT * FROM events WHERE task_id=? AND (
          (type='task.status_changed' AND json_extract(payload,'$.to')=?) OR
          type IN ('worker.stopped','task.merge_conflict','task.frozen','task.lease_expired_locked') OR
          (?=1 AND type='task.updated' AND json_extract(payload,'$.after.frozen')=1 AND json_extract(payload,'$.before.frozen')=0)
        ) ORDER BY id DESC LIMIT 1`,
        row.id,
        row.status,
        row.frozen,
      );
      const payload = event ? (JSON.parse(event.payload) as { reason?: string }) : {};
      return {
        id: `task-${row.id}`,
        kind,
        task: this.summary(row),
        title: row.title,
        reason:
          kind === 'approval'
            ? approval!.reason
            : row.lease_expired_at
              ? '任务租约已到期，请检查执行现场。'
              : row.frozen
                ? handoff.summary
                : payload.reason || handoff.summary,
        since:
          kind === 'approval'
            ? approval!.created_at
            : (row.lease_expired_at ?? event?.created_at ?? row.created_at),
        priority: row.priority,
        impact: impact(row.id),
        handoff,
      };
    });
    const questions = this.store.all<Omit<Mention, 'message'>>(
      `SELECT n.id,n.message_id,n.state,n.created_at FROM mentions n JOIN messages m ON m.id=n.message_id
       WHERE n.handle=? AND n.state!='resolved' AND m.kind='question'
       AND (m.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=m.task_id AND t.status NOT IN ('done','cancelled')))`,
      actor.handle,
    );
    for (const question of questions) {
      const message = this.store.get<Message>(
        'SELECT m.*,c.name channel_name FROM messages m LEFT JOIN channels c ON c.id=m.channel_id WHERE m.id=?',
        question.message_id,
      )!;
      const task = message.task_id ? this.task(message.task_id) : null;
      items.push({
        id: `question-${question.id}`,
        kind: 'question',
        task,
        title: task?.title ?? message.channel_name ?? `@${message.author}`,
        reason: message.body,
        since: question.created_at,
        priority: task?.priority ?? 'P2',
        impact: task ? impact(task.id) : 0,
        handoff: null,
        mention: { ...question, message },
      });
    }
    const filtered = items.filter((item) => p.kind === 'all' || item.kind === p.kind);
    filtered.sort(
      (a, b) =>
        (p.sort === 'impact'
          ? b.impact - a.impact
          : p.sort === 'priority'
            ? a.priority.localeCompare(b.priority)
            : 0) ||
        a.since.localeCompare(b.since) ||
        a.id.localeCompare(b.id),
    );
    return { items: filtered.slice(p.offset, p.offset + p.limit), total: filtered.length };
  }
  private participants(): Participant[] {
    const statistics = this.store.all<{
      handle: string;
      completed: number;
      average_completion_ms: number | null;
      reviews: number;
      rejections: number;
    }>(`WITH review_events AS (
      SELECT coalesce(json_extract(e.payload,'$.assignee'),t.assignee) handle,
        e.task_id,e.created_at,json_extract(e.payload,'$.to') verdict
      FROM events e JOIN tasks t ON t.id=e.task_id
      WHERE e.type='task.status_changed' AND json_extract(e.payload,'$.from')='in_review'
        AND json_extract(e.payload,'$.to') IN ('done','changes_requested')
    ) SELECT handle,count(*) reviews,
      sum(verdict='changes_requested') rejections, sum(verdict='done') completed,
      avg(CASE WHEN verdict='done' THEN max(0,(julianday(created_at)-julianday((
        SELECT min(s.created_at) FROM events s WHERE s.task_id=r.task_id AND s.type='task.status_changed'
          AND json_extract(s.payload,'$.to')='in_progress'
      )))*86400000) END) average_completion_ms
    FROM review_events r GROUP BY handle`);
    return this.store
      .all<ParticipantRow>(
        `SELECT ${participantColumns} FROM participants WHERE enabled=1 ORDER BY kind DESC,handle`,
      )
      .map((row) => ({
        ...this.publicParticipant(row),
        statistics: (() => {
          const s = statistics.find((s) => s.handle === row.handle);
          return {
            completed: s?.completed ?? 0,
            average_completion_ms: s?.average_completion_ms ?? null,
            reviews: s?.reviews ?? 0,
            rejections: s?.rejections ?? 0,
            rejection_rate: s?.reviews ? s.rejections / s.reviews : null,
          };
        })(),
        unread: this.unread(row.handle),
        current_tasks: this.store
          .all<TaskRow>(
            "SELECT * FROM tasks WHERE assignee=? AND status NOT IN ('done','cancelled','draft','open') ORDER BY priority,id",
            row.handle,
          )
          .map((t) => this.summary(t)),
      }));
  }
  private renew(taskId: number): void {
    this.store.run(
      `UPDATE tasks SET lease_until=?,lease_expired_at=NULL,updated_at=? WHERE id=? AND assignee IS NOT NULL AND status IN ('claimed','in_progress','changes_requested')`,
      this.lease(),
      this.timestamp(),
      taskId,
    );
  }
  private dependenciesDone(task: Task): void {
    const pending = task.depends_on.filter((id) => this.task(id).status !== 'done');
    check(
      pending.length === 0,
      'dependencies_pending',
      `T-${task.id} is waiting for ${pending.map((id) => `T-${id}`).join(', ')}.`,
      'Complete its dependencies before claiming or starting this task.',
    );
  }
  private lockFor(actor: Participant, task: Task): void {
    if (!task.writes_code) return;
    check(
      task.repository,
      'repository_required',
      'Choose a repository before starting code work.',
      'Use update_task with the absolute repository path, then start the task.',
      400,
    );
    this.checkLegacyLock();
    const lock = this.lock(task.repository);
    check(
      !lock.holder || (lock.task_id === task.id && lock.holder === task.assignee),
      'write_lock_held',
      `Code writing is locked by @${lock.holder}${lock.task_id ? ` on T-${lock.task_id}` : ''}.`,
      'Wait for the current writer to submit, or ask @human to inspect and release the lock.',
    );
    if (!lock.holder) {
      this.store.run(
        'INSERT INTO write_locks(holder,task_id,acquired_at,repository) VALUES(?,?,?,?)',
        task.assignee,
        task.id,
        this.timestamp(),
        task.repository,
      );
      this.event(actor.handle, 'lock.acquired', task.id, {
        holder: task.assignee,
        repository: task.repository,
      });
    }
  }
  private unlockTask(actor: string, task: Task): void {
    const lock = this.taskLock(task);
    if (lock.task_id !== task.id) return;
    this.store.run('DELETE FROM write_locks WHERE repository=?', lock.repository ?? '');
    this.event(actor, 'lock.released', task.id, {
      holder: task.assignee,
      repository: lock.repository,
    });
  }
  private changeStatus(actor: Participant, task: Task, status: TaskStatus, reason: string): void {
    if (['claimed', 'in_progress'].includes(status)) this.executionApproved(task);
    check(
      transitions[task.status].includes(status),
      'invalid_transition',
      `T-${task.id} cannot move from ${task.status} to ${status}.`,
      `Allowed transitions: ${transitions[task.status].join(', ') || 'none; terminal tasks cannot be reopened'}.`,
    );
    check(
      actor.kind === 'human' || !isGated(this.settings(), task.status, status, task.type),
      'approval_required',
      `Moving T-${task.id} to ${status} requires human approval.`,
      `Call request_approval(id=${task.id}, to_status='${status}', reason='...').`,
      403,
    );
    if (status === 'cancelled') this.human(actor);
    if (status === 'in_progress') {
      check(
        task.assignee,
        'assignee_required',
        'This task has no assignee.',
        'Claim or assign it before starting.',
      );
      check(
        actor.kind === 'human' || task.attempt < this.settings().max_attempts,
        'attempt_limit',
        'This task reached the review attempt limit.',
        'Ask @human to decide how to continue.',
      );
      check(
        !this.participant(task.assignee).frozen,
        'assignee_frozen',
        'The assignee has been paused.',
        'Resume or reassign the participant first.',
      );
      this.dependenciesDone(task);
      const count = this.store.get<{ n: number }>(
        "SELECT count(*) n FROM tasks WHERE assignee=? AND status='in_progress' AND id!=?",
        task.assignee,
        task.id,
      )!.n;
      check(
        count < this.settings().max_in_progress,
        'task_limit',
        `@${task.assignee} has reached the active task limit.`,
        'Finish or release the current task before starting another.',
      );
      this.lockFor(actor, task);
    }
    const managed = this.store.get(
      "SELECT 1 FROM worker_runs WHERE task_id=? AND state='active'",
      task.id,
    );
    // Managed shared-directory work reserves the repository through independent review.
    if (['done', 'cancelled'].includes(status) || (status === 'in_review' && !managed))
      this.unlockTask(actor.handle, task);
    const hasLease = leasedStatuses.includes(status) && task.assignee !== null;
    this.store.run(
      'UPDATE tasks SET status=?,lease_until=?,lease_expired_at=NULL,updated_at=? WHERE id=?',
      status,
      hasLease ? this.lease() : null,
      this.timestamp(),
      task.id,
    );
    this.store.run(
      "UPDATE approvals SET state=CASE WHEN to_status=? THEN 'approved' ELSE 'superseded' END,resolved_by=?,resolved_at=? WHERE task_id=? AND state='pending'",
      status,
      actor.handle,
      this.timestamp(),
      task.id,
    );
    this.event(actor.handle, 'task.status_changed', task.id, {
      from: task.status,
      to: status,
      reason,
      assignee: task.assignee,
    });
    if (managed)
      this.store.run(
        `UPDATE worker_runs SET state=CASE
        WHEN (mode='implement' AND ?='in_review') OR (mode='review' AND ? IN ('done','changes_requested')) THEN 'completed' ELSE 'stopped' END
        WHERE task_id=? AND state='active' AND ((mode='implement' AND ?!='in_progress') OR (mode='review' AND ?!='in_review'))`,
        status,
        status,
        task.id,
        status,
        status,
      );
    if (managed)
      this.store.run(
        "DELETE FROM sessions WHERE id IN (SELECT id FROM worker_runs WHERE task_id=? AND state!='active')",
        task.id,
      );
  }
  private addArtifacts(actor: Participant, taskId: number, artifacts: ArtifactInput[]): void {
    for (const a of artifacts) {
      const result = this.store.run(
        'INSERT OR IGNORE INTO artifacts(task_id,kind,ref,label,created_by,created_at) VALUES(?,?,?,?,?,?)',
        taskId,
        a.kind,
        a.ref,
        a.label ?? null,
        actor.handle,
        this.timestamp(),
      );
      if (result.changes)
        this.event(actor.handle, 'artifact.added', taskId, { ...a, id: result.id });
    }
  }
  private createTask(actor: Participant, p: Parsed<'create_task'>): Task {
    if (this.settings().approval_mode === 'plan') {
      if (p.type === 'plan') {
        check(
          !p.parent_id && !p.writes_code,
          'invalid_plan',
          'A plan is a top-level, non-writing container.',
          'Create implementation tasks under the plan.',
          400,
        );
        p.draft = true;
      } else if (p.type === 'merge') p.draft = true;
      const plan = p.parent_id ? this.planFor(this.task(p.parent_id)) : undefined;
      check(
        !plan?.plan_approved_at,
        'plan_scope_locked',
        'This plan has already been approved.',
        'Create a follow-up plan for additional scope.',
      );
      if (
        actor.kind === 'agent' &&
        (p.writes_code || ['implement', 'bug', 'merge'].includes(p.type))
      )
        check(
          plan,
          'plan_required',
          'Agent-created code work must belong to a plan.',
          'Create a draft plan and its child tasks, then request plan approval.',
          403,
        );
    }
    check(
      actor.kind === 'human' || this.settings().roles[actor.role ?? '']?.includes(p.type),
      'role_forbidden',
      `Your role cannot create ${p.type} tasks.`,
      'Ask @planner or @human to create this task.',
      403,
    );
    check(
      p.draft || actor.kind === 'human' || !isGated(this.settings(), 'draft', 'open', p.type),
      'approval_required',
      'Publishing this task type requires human approval.',
      'Create it with draft=true, then call request_approval to publish.',
      403,
    );
    if (p.parent_id)
      check(
        !terminal(this.task(p.parent_id)),
        'parent_closed',
        'The parent task is already closed.',
        'Choose an active parent task.',
      );
    for (const dep of p.depends_on) this.task(dep);
    const result = this.store.run(
      `INSERT INTO tasks(title,description,type,status,priority,creator,role_hint,parent_id,context,writes_code,created_at,updated_at,repository,workflow_plan) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.title,
      p.description,
      p.type,
      p.draft ? 'draft' : 'open',
      p.priority,
      actor.handle,
      p.role_hint ?? null,
      p.parent_id ?? null,
      JSON.stringify(p.context),
      Number(p.writes_code || ['implement', 'bug', 'merge'].includes(p.type)),
      this.timestamp(),
      this.timestamp(),
      p.repository ?? null,
      Number(p.type === 'plan' && this.settings().approval_mode === 'plan'),
    );
    for (const dep of new Set(p.depends_on))
      this.store.run('INSERT INTO task_dependencies VALUES(?,?)', result.id, dep);
    p.acceptance_criteria.forEach((value, position) =>
      this.store.run(
        'INSERT INTO acceptance_criteria(task_id,text,position) VALUES(?,?,?)',
        result.id,
        value,
        position,
      ),
    );
    for (const label of new Set(p.labels))
      this.store.run('INSERT INTO labels VALUES(?,?)', result.id, label);
    const task = this.task(result.id);
    this.event(actor.handle, 'task.created', task.id, { task });
    return task;
  }
  private planFor(task: Task): Task | undefined {
    if (task.workflow_plan) return task;
    return task.parent_id ? this.planFor(this.task(task.parent_id)) : undefined;
  }
  private canExecute(task: Task): boolean {
    if (this.settings().approval_mode !== 'plan') return true;
    const plan = this.planFor(task);
    return (
      !task.workflow_plan &&
      (!plan || Boolean(plan.plan_approved_at && plan.status === 'open' && !plan.frozen))
    );
  }
  private executionApproved(task: Task): void {
    check(
      this.canExecute(task),
      'plan_approval_required',
      'The plan must be approved before its tasks can run.',
      'Request publication of the draft plan in Dashboard. Plans are containers; dispatch their children.',
      403,
    );
  }
  private completePlan(actor: Participant, p: Parsed<'complete_plan'>): Task {
    const plan = this.task(p.id);
    this.writable(actor, plan);
    check(
      actor.kind === 'human' || actor.role === 'planner',
      'planner_required',
      'Only the planner can complete a plan.',
      'Return to the coordinator.',
      403,
    );
    check(
      plan.type === 'plan' && plan.plan_approved_at && plan.status === 'open',
      'plan_not_approved',
      'Only an approved open plan can be completed.',
      'Read the plan and its approval state.',
    );
    const children = this.store.all<{ id: number; status: string }>(
      `WITH RECURSIVE children(id,status) AS (
      SELECT id,status FROM tasks WHERE parent_id=? UNION ALL
      SELECT t.id,t.status FROM tasks t JOIN children c ON t.parent_id=c.id
    ) SELECT * FROM children`,
      plan.id,
    );
    check(
      children.length && children.every((t) => ['done', 'cancelled'].includes(t.status)),
      'plan_incomplete',
      'The plan still has unfinished work, or contains no tasks.',
      'Finish its children before completing the plan.',
    );
    check(
      p.criteria_passed.every((id) => plan.acceptance_criteria.some((c) => c.id === id)) &&
        plan.acceptance_criteria.every((c) => p.criteria_passed.includes(c.id)),
      'criteria_incomplete',
      'The plan criteria still need verification against the reviewed deliverables.',
      'Supply each verified plan criterion ID in criteria_passed.',
    );
    this.store.run(
      'UPDATE acceptance_criteria SET checked=1,checked_by=? WHERE task_id=?',
      actor.handle,
      plan.id,
    );
    this.store.run(
      "UPDATE tasks SET status='done',updated_at=? WHERE id=?",
      this.timestamp(),
      plan.id,
    );
    this.event(actor.handle, 'task.status_changed', plan.id, {
      from: 'open',
      to: 'done',
      reason: p.summary,
    });
    this.systemMessage(actor, plan.id, `计划完成：${p.summary}`, [], 'report');
    return this.task(plan.id);
  }
  private run(id: string): WorkerRun {
    const run = this.store.get<WorkerRun>('SELECT * FROM worker_runs WHERE id=?', id);
    check(
      run,
      'worker_not_found',
      'This worker assignment does not exist.',
      'Use the run_id returned by dispatch_task.',
      404,
    );
    return run;
  }
  workerActor(token: string | undefined, id: string): Participant {
    this.agentAccess(token);
    return this.participant(this.run(id).handle);
  }
  private assignment(run: WorkerRun): WorkerAssignment {
    const task = this.task(run.task_id);
    task.thread = this.thread(this.participant(run.handle), {
      task_id: task.id,
      since: 0,
      limit: 100,
    });
    return {
      run_id: run.id,
      mode: run.mode,
      state: run.state,
      handle: run.handle,
      task,
      commit_sha: run.mode === 'review' ? run.commit_sha : run.submitted_commit_sha,
      submitted_commit_sha: run.submitted_commit_sha,
      evidence_directory: run.evidence_directory ?? this.evidencePath(run.task_id, run.id),
      evidence: JSON.parse(run.evidence) as Evidence[],
      handoff: this.handoff(task),
      heartbeat_after_ms: Math.max(100, Math.min(10000, this.settings().lease_minutes * 20000)),
    };
  }
  private evidencePath(taskId: number, runId: string): string {
    return join(this.evidenceRoot, `T-${taskId}`, runId);
  }
  private prepareEvidenceDirectory(run: WorkerRun, task: Task): void {
    const path = run.evidence_directory ?? this.evidencePath(task.id, run.id);
    check(
      !task.repository || (!insideDirectory(task.repository, path) && task.repository !== path),
      'evidence_in_repository',
      'The evidence directory must be outside the task repository.',
      'Configure an evidence directory outside the working tree.',
    );
    mkdirSync(path, { recursive: true });
    const canonical = realpathSync(path);
    check(
      !task.repository ||
        (!insideDirectory(task.repository, canonical) && task.repository !== canonical),
      'evidence_in_repository',
      'The evidence directory resolves inside the task repository.',
      'Configure an evidence directory outside the working tree.',
    );
    this.store.run('UPDATE worker_runs SET evidence_directory=? WHERE id=?', canonical, run.id);
  }
  private handoff(task: Task): Handoff {
    const active = this.store.get<WorkerRun>(
      "SELECT * FROM worker_runs WHERE task_id=? AND state='active'",
      task.id,
    );
    const latest =
      active ??
      this.store.get<WorkerRun>(
        'SELECT * FROM worker_runs WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        task.id,
      );
    const coordinator = latest?.coordinator ?? task.creator;
    const workerHandle = active?.handle ?? task.assignee;
    const worker = workerHandle
      ? this.store.get<{ frozen: number; enabled: number }>(
          'SELECT frozen,enabled FROM participants WHERE handle=?',
          workerHandle,
        )
      : undefined;
    const lock = this.taskLock(task);
    const result: Handoff = {
      summary: `T-${task.id}: ${task.status}`,
      next_action: {
        action: 'inspect_task',
        actor: coordinator,
        reason: 'Read the task before proceeding.',
      },
      blockers: [],
      lock:
        lock.task_id === task.id
          ? {
              ...lock,
              purpose:
                task.status === 'in_review'
                  ? '本任务保留仓库锁以保护待验收版本；coder 已结束本轮修改，tester 可验收。'
                  : '本任务占用仓库，其他任务需等待本任务释放。',
            }
          : null,
    };
    const next = (
      summary: string,
      action: Handoff['next_action']['action'],
      actor: string,
      reason: string,
    ) => {
      result.summary = summary;
      result.next_action = { action, actor, reason };
    };
    const block = (code: string, reason: string, actor = 'human') => {
      result.blockers.push({ code, task_id: task.id, reason });
      next(reason, 'resolve_blocker', actor, reason);
    };
    if (terminal(task))
      next(
        `任务已${task.status === 'done' ? '完成' : '取消'}。`,
        'none',
        coordinator,
        'No further work is required.',
      );
    else if (task.frozen) block('task_frozen', '任务当前已冻结，需要人工检查后恢复。');
    else if (worker && !worker.enabled)
      block('participant_disabled', '当前执行身份已停用，需要人工恢复配置或改派。');
    else if (worker?.frozen) block('agent_frozen', '当前执行身份已冻结，需要人工恢复。');
    else if (task.attempt >= this.settings().max_attempts)
      block('attempt_limit', '返工次数已达上限，需要人工处理。');
    else if (this.store.get("SELECT 1 FROM approvals WHERE task_id=? AND state='pending'", task.id))
      next(
        '任务等待人工审批。',
        'wait_for_approval',
        'human',
        'Resolve the pending approval in Dashboard.',
      );
    else if (task.writes_code && !task.repository)
      block('repository_required', '代码任务尚未绑定仓库，需先确认工作目录。', coordinator);
    else if (task.writes_code && lock.holder && lock.task_id !== task.id)
      block('write_lock_held', `仓库正在由任务 T-${lock.task_id} 占用。`, coordinator);
    else if (!task.workflow_plan && !this.canExecute(task)) {
      const plan = this.planFor(task)!;
      if (plan.frozen || terminal(plan))
        block('plan_unavailable', `父计划 T-${plan.id} 已冻结或结束，当前任务不可执行。`);
      else if (
        this.store.get("SELECT 1 FROM approvals WHERE task_id=? AND state='pending'", plan.id)
      )
        next(
          `父计划 T-${plan.id} 等待人工审批。`,
          'wait_for_approval',
          'human',
          `Resolve the pending approval for plan T-${plan.id} in Dashboard.`,
        );
      else
        next(
          `任务范围等待父计划 T-${plan.id} 批准。`,
          'request_approval',
          coordinator,
          `Submit plan T-${plan.id} for approval; its approval covers this task.`,
        );
    } else if (active)
      next(
        active.mode === 'review'
          ? '已派发独立验收；执行者是否启动需由宿主确认。'
          : '已派发实现；执行者是否启动需由宿主确认。',
        active.mode === 'review' ? 'review' : 'implement',
        active.handle,
        `Use get_task with run_id ${active.id}. The host must check its executor mapping before launching or resuming a worker.`,
      );
    else if (task.status === 'in_review')
      next(
        `提交${task.submitted_commit_sha ? ` ${task.submitted_commit_sha}` : ''}已接受，等待独立验收。`,
        'dispatch_review',
        coordinator,
        'Dispatch an independent tester, then launch it through the host.',
      );
    else if (task.status === 'blocked') {
      result.blockers.push({
        code: 'task_blocked',
        task_id: task.id,
        reason: '任务已阻塞，需先检查执行现场。',
      });
      next(
        '任务已阻塞，现场与锁保留。',
        'inspect_and_resume',
        coordinator,
        'Confirm the previous executor stopped and resolve the reported problem before dispatching again.',
      );
    } else if (task.status === 'changes_requested')
      next(
        '独立验收要求返工。',
        'dispatch_implement',
        coordinator,
        'Dispatch the original coder with a new run_id.',
      );
    else if (task.status === 'draft' && isGated(this.settings(), 'draft', 'open', task.type))
      next(
        '任务范围等待批准。',
        'request_approval',
        coordinator,
        'Submit the completed scope for approval.',
      );
    else if (task.status === 'open' || task.status === 'draft') {
      const waiting = task.depends_on.filter(
        (id) =>
          this.store.get<{ status: string }>('SELECT status FROM tasks WHERE id=?', id)?.status !==
          'done',
      );
      if (waiting.length)
        block('dependencies_incomplete', `等待前置任务：${waiting.join(', ')}。`, coordinator);
      else if (
        task.type === 'plan' &&
        this.store.get(
          "SELECT 1 FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled')",
          task.id,
        )
      )
        next(
          '计划已批准，继续推进尚未完成的子任务。',
          'follow_children',
          coordinator,
          'Use pending tasks to dispatch ready work or follow existing workers.',
        );
      else
        next(
          '任务等待执行。',
          task.type === 'plan' ? 'complete_plan' : 'dispatch_implement',
          coordinator,
          task.type === 'plan'
            ? 'Complete the plan only after all children finish.'
            : 'Dispatch a coder and launch it through the host.',
        );
    }
    return result;
  }
  private pending(actor: Participant): NonNullable<Identity['pending']> {
    return this.store
      .all<{ id: number }>(
        `SELECT DISTINCT t.id FROM tasks t LEFT JOIN worker_runs r ON r.task_id=t.id
       WHERE t.status NOT IN ('done','cancelled') AND (t.creator=? OR t.assignee=? OR t.reviewer=? OR r.coordinator=?) ORDER BY t.id`,
        actor.handle,
        actor.handle,
        actor.handle,
        actor.handle,
      )
      .map(({ id }) => ({
        task_id: id,
        run_id:
          this.store.get<{ id: string }>(
            "SELECT id FROM worker_runs WHERE task_id=? AND state='active'",
            id,
          )?.id ?? null,
        handoff: this.handoff(this.task(id)),
      }));
  }
  private activeRun(actor: Participant, id: string, mode?: WorkerRun['mode']): WorkerRun {
    const run = this.run(id);
    const task = this.task(run.task_id);
    this.writable(actor, task);
    check(
      actor.handle === run.handle &&
        run.state === 'active' &&
        run.lease_until > this.timestamp() &&
        (!mode || run.mode === mode) &&
        (run.mode === 'implement'
          ? task.status === 'in_progress' && task.assignee === run.handle
          : task.status === 'in_review' && task.reviewer === run.handle),
      'worker_inactive',
      'This worker no longer owns this phase of the task.',
      'Return to the coordinator; do not reuse an old run_id.',
    );
    this.executionApproved(task);
    return run;
  }
  private dispatch(actor: Participant, p: Parsed<'dispatch_task'>): WorkerAssignment {
    check(
      actor.kind === 'human' || actor.role === 'planner',
      'planner_required',
      'Only the planner may dispatch workers.',
      'Return to the coordinator.',
      403,
    );
    let task = this.task(p.id);
    this.writable(actor, task);
    this.executionApproved(task);
    check(
      task.type !== 'plan',
      'plan_container',
      'Dispatch a child task, not the plan.',
      'Read the plan children.',
    );
    const existing = this.store.get<WorkerRun>(
      "SELECT * FROM worker_runs WHERE task_id=? AND state='active'",
      task.id,
    );
    if (existing) {
      check(
        existing.coordinator === actor.handle &&
          existing.handle === p.handle &&
          existing.mode === p.mode,
        'worker_active',
        'This task already has an active worker.',
        'Follow up the existing worker; stop it before replacing it.',
      );
      this.activeRun(this.participant(existing.handle), existing.id, p.mode);
      this.prepareEvidenceDirectory(existing, task);
      return this.assignment(this.run(existing.id));
    }
    const role = p.mode === 'implement' ? 'implementer' : 'tester';
    const previous = this.store.get<{ kind: string; role: string; enabled: number }>(
      'SELECT kind,role,enabled FROM participants WHERE handle=?',
      p.handle,
    );
    if (!previous)
      this.store.run(
        "INSERT INTO participants(handle,kind,role,token_hash,status,enabled,managed) VALUES(?,'agent',?,?,'offline',1,0)",
        p.handle,
        role,
        `agent:${p.handle}`,
      );
    const worker = this.participant(p.handle);
    this.writable(worker, task);
    check(
      worker.kind === 'agent' &&
        (p.mode === 'implement'
          ? worker.role === 'implementer'
          : ['tester', 'reviewer'].includes(worker.role ?? '')),
      'worker_role_mismatch',
      'The worker role does not match its assignment.',
      'Choose an implementer for coding or an independent tester/reviewer.',
      403,
    );
    if (p.mode === 'implement') {
      check(
        task.status !== 'draft' || !isGated(this.settings(), 'draft', 'open', task.type),
        'approval_required',
        'Dispatch requires approval to publish this task.',
        'Request approval for the open transition in Dashboard.',
        403,
      );
      if (task.status === 'draft' && !isGated(this.settings(), 'draft', 'open', task.type)) {
        this.changeStatus(actor, task, 'open', 'Published for dispatch');
        task = this.task(task.id);
      }
      if (task.status === 'open') task = this.claim(worker, task.id);
      this.owner(worker, task);
      check(
        ['claimed', 'changes_requested', 'blocked', 'in_progress'].includes(task.status),
        'cannot_dispatch',
        'This task is not ready for implementation.',
        'Read its current state and approvals.',
      );
      if (task.status !== 'in_progress')
        this.changeStatus(worker, task, 'in_progress', `Dispatched by @${actor.handle}`);
    } else {
      this.reviewer(worker, task);
      check(
        !task.repository ||
          !this.lock(task.repository).holder ||
          this.lock(task.repository).task_id === task.id,
        'write_lock_held',
        'Another task is writing in this repository.',
        'Wait until that writer has stopped.',
      );
      this.lockFor(worker, task);
      this.store.run('UPDATE tasks SET reviewer=? WHERE id=?', worker.handle, task.id);
    }
    const sha = p.mode === 'review' ? this.submissionSha(task.id) : null;
    const id = randomUUID();
    this.store.run(
      'INSERT INTO worker_runs(id,task_id,handle,coordinator,mode,commit_sha,lease_until,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id,
      task.id,
      worker.handle,
      actor.handle,
      p.mode,
      sha,
      this.lease(),
      this.timestamp(),
    );
    this.store.run(
      'INSERT INTO sessions(id,handle,last_seen_at) VALUES(?,?,?)',
      id,
      worker.handle,
      this.timestamp(),
    );
    this.store.run(
      "UPDATE participants SET status='online',last_seen_at=? WHERE handle=?",
      this.timestamp(),
      worker.handle,
    );
    this.event(actor.handle, 'worker.dispatched', task.id, {
      run_id: id,
      handle: worker.handle,
      mode: p.mode,
      commit_sha: sha,
    });
    this.prepareEvidenceDirectory(this.run(id), task);
    return this.assignment(this.run(id));
  }
  private submissionSha(id: number): string | null {
    // Select the submission event, not the latest artifact: resubmitting the same SHA does not insert another artifact.
    const row = this.store.get<{ payload: string }>(
      "SELECT payload FROM events WHERE task_id=? AND type='task.submitted' ORDER BY id DESC LIMIT 1",
      id,
    );
    return row ? (JSON.parse(row.payload) as { commit_sha: string | null }).commit_sha : null;
  }
  private stopRun(
    actor: Participant,
    run: WorkerRun,
    reason: string,
    state: 'stopped' | 'expired' = 'stopped',
    conflict = false,
  ): WorkerAssignment {
    this.store.run('UPDATE worker_runs SET state=? WHERE id=?', state, run.id);
    this.store.run('DELETE FROM sessions WHERE id=?', run.id);
    const task = this.task(run.task_id);
    if (['in_progress', 'in_review'].includes(task.status)) {
      const status = run.mode === 'review' ? 'in_review' : 'blocked';
      this.store.run(
        'UPDATE tasks SET status=?,frozen=CASE WHEN ? THEN 1 ELSE frozen END,lease_until=NULL,lease_expired_at=NULL,updated_at=? WHERE id=?',
        status,
        Number(conflict),
        this.timestamp(),
        task.id,
      );
      this.event(actor.handle, conflict ? 'task.merge_conflict' : 'worker.stopped', task.id, {
        run_id: run.id,
        from: task.status,
        to: status,
        reason,
      });
      this.systemMessage(
        actor,
        task.id,
        reason,
        conflict ? ['human', run.coordinator] : [run.coordinator],
        'system',
        run.id,
      );
    }
    return this.assignment(this.run(run.id));
  }
  private workerOperation(
    actor: Participant,
    operation: Operation,
    input: unknown,
    evidence: Evidence[] = [],
  ): unknown {
    const { run_id } = schemas.worker_get_task.parse({
      run_id: (input as { run_id: string }).run_id,
    });
    const run = this.run(run_id);
    check(
      actor.handle === run.handle,
      'worker_identity',
      'This assignment belongs to another worker.',
      'Use your own run_id.',
      403,
    );
    if (operation === 'worker_get_task') return this.assignment(run);
    if (operation === 'worker_heartbeat' && run.state !== 'active') return { state: run.state };
    this.activeRun(actor, run_id);
    if (operation === 'worker_heartbeat') {
      this.store.run('UPDATE worker_runs SET lease_until=? WHERE id=?', this.lease(), run_id);
      this.store.run('UPDATE sessions SET last_seen_at=? WHERE id=?', this.timestamp(), run_id);
      this.store.run(
        'UPDATE participants SET last_seen_at=? WHERE handle=?',
        this.timestamp(),
        actor.handle,
      );
      if (run.mode === 'implement')
        this.store.run(
          'UPDATE tasks SET lease_until=?,lease_expired_at=NULL WHERE id=?',
          this.lease(),
          run.task_id,
        );
      return { state: 'active' };
    }
    if (operation === 'worker_post_message') {
      const p = schemas.worker_post_message.parse(input);
      if (p.escalation) {
        check(
          this.task(run.task_id).type === 'merge' && run.mode === 'implement',
          'not_merge_worker',
          'Only a merge worker can report a merge conflict.',
          'Report other findings as a normal message.',
        );
        return this.stopRun(actor, run, `合入冲突：${p.body}`, 'stopped', true);
      }
      return this.postMessage(
        actor,
        {
          task_id: run.task_id,
          body: p.body,
          kind: p.kind,
          mentions: [],
        },
        run_id,
      );
    }
    let task: Task;
    if (operation === 'worker_submit') {
      this.activeRun(actor, run_id, 'implement');
      const p = schemas.worker_submit.parse(input);
      task = this.submit(
        actor,
        {
          id: run.task_id,
          summary: p.summary,
          artifacts: [
            ...p.artifacts,
            ...(p.commit_sha ? [{ kind: 'commit' as const, ref: p.commit_sha }] : []),
          ],
        },
        run_id,
      );
      this.store.run(
        'UPDATE worker_runs SET submitted_commit_sha=? WHERE id=?',
        p.commit_sha ?? null,
        run_id,
      );
    } else {
      this.activeRun(actor, run_id, 'review');
      const p = schemas.worker_review.parse(input);
      task = this.task(run.task_id);
      check(
        !task.writes_code || (p.commit_sha && p.commit_sha === run.commit_sha),
        'review_version_mismatch',
        'Review must identify the assigned submission SHA.',
        'Use commit_sha from get_task; verify this version.',
      );
      const passed = new Set(p.criteria_passed);
      check(
        p.criteria_passed.every((id) => task.acceptance_criteria.some((c) => c.id === id)) &&
          (p.verdict !== 'approve' || task.acceptance_criteria.every((c) => passed.has(c.id))),
        'criteria_incomplete',
        'Approval requires every acceptance criterion to be independently verified.',
        'Supply the verified criterion IDs in criteria_passed or request changes.',
      );
      for (const c of task.acceptance_criteria)
        this.store.run(
          'UPDATE acceptance_criteria SET checked=?,checked_by=? WHERE id=?',
          Number(passed.has(c.id)),
          passed.has(c.id) ? actor.handle : null,
          c.id,
        );
      if (p.verdict === 'approve' && isGated(this.settings(), 'in_review', 'done', task.type)) {
        this.reviewer(actor, task);
        this.systemMessage(
          actor,
          task.id,
          `独立验收通过，等待自定义人工审批：${p.comments}`,
          [run.coordinator],
          'report',
        );
        this.requestApproval(actor, { id: task.id, to_status: 'done', reason: p.comments });
        task = this.task(task.id);
      } else task = this.review(actor, { id: task.id, verdict: p.verdict, comments: p.comments });
    }
    this.store.run("UPDATE worker_runs SET state='completed' WHERE id=?", run_id);
    this.store.run(
      'UPDATE worker_runs SET evidence=? WHERE id=?',
      JSON.stringify(evidence),
      run_id,
    );
    this.store.run('DELETE FROM sessions WHERE id=?', run_id);
    const receipt = input as { summary?: string; comments?: string; verdict?: string };
    this.event(actor.handle, 'worker.completed', task.id, {
      run_id,
      evidence,
      summary: receipt.summary ?? receipt.comments,
      ...(receipt.verdict ? { verdict: receipt.verdict } : {}),
    });
    return this.assignment(this.run(run_id));
  }
  private claim(actor: Participant, id: number): Task {
    const task = this.task(id);
    this.writable(actor, task);
    this.executionApproved(task);
    check(
      task.status === 'open' && !task.assignee,
      'already_claimed',
      `T-${id} is ${task.status}${task.assignee ? ` and assigned to @${task.assignee}` : ''}.`,
      "Use list_tasks(status='open') to find available work.",
    );
    check(
      actor.kind === 'human' || !task.role_hint || actor.role === task.role_hint,
      'role_mismatch',
      `T-${id} requires role ${task.role_hint}.`,
      'Claim a task matching your configured role.',
      403,
    );
    this.dependenciesDone(task);
    check(
      actor.kind === 'human' || task.attempt < this.settings().max_attempts,
      'attempt_limit',
      'This task reached the review attempt limit.',
      'Ask @human to decide how to continue.',
    );
    // Limit outstanding claims too, so an agent cannot reserve the whole queue.
    const count = this.store.get<{ n: number }>(
      "SELECT count(*) n FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','blocked','changes_requested')",
      actor.handle,
    )!.n;
    check(
      count < this.settings().max_in_progress,
      'task_limit',
      'You already hold the maximum number of active tasks.',
      'Finish or release your current task before claiming more.',
    );
    check(
      actor.kind === 'human' || !isGated(this.settings(), 'open', 'claimed', task.type),
      'approval_required',
      'Claiming this task requires a human.',
      'Ask @human to assign this task.',
      403,
    );
    const result = this.store.run(
      "UPDATE tasks SET status='claimed',assignee=?,lease_until=?,lease_expired_at=NULL,updated_at=? WHERE id=? AND status='open' AND assignee IS NULL",
      actor.handle,
      this.lease(),
      this.timestamp(),
      id,
    );
    check(
      result.changes === 1,
      'already_claimed',
      `T-${id} was claimed by another participant.`,
      'Use claim_next to find other work.',
    );
    this.event(actor.handle, 'task.claimed', id, {
      from: 'open',
      to: 'claimed',
      assignee: actor.handle,
    });
    return this.task(id);
  }
  private claimNext(actor: Participant, p: Parsed<'claim_next'>): Task {
    const rows = this.store.all<{ id: number }>(
      `SELECT t.id FROM tasks t WHERE t.status='open' AND t.assignee IS NULL AND t.frozen=0
      AND (? IS NULL OR t.role_hint=?) AND (?='human' OR t.role_hint IS NULL OR t.role_hint=?)
      AND (?='human' OR t.attempt<?)
      AND (? IS NULL OR t.repository=?)
      AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.depends_on_id WHERE d.task_id=t.id AND dep.status!='done')
      ORDER BY t.priority,t.id`,
      p.role_hint ?? null,
      p.role_hint ?? null,
      actor.kind,
      actor.role,
      actor.kind,
      this.settings().max_attempts,
      p.repository ?? null,
      p.repository ?? null,
    );
    const candidate = rows.find(
      (r) =>
        this.canExecute(this.task(r.id)) &&
        (actor.kind === 'human' ||
          !isGated(this.settings(), 'open', 'claimed', this.task(r.id).type)),
    );
    check(
      candidate,
      'no_eligible_task',
      'There are no eligible open tasks for your role.',
      'Check your inbox or wait for dependencies and approvals.',
    );
    return this.claim(actor, candidate.id);
  }
  private updateTask(actor: Participant, p: Parsed<'update_task'>): Task {
    let task = this.task(p.id);
    if (this.settings().approval_mode === 'plan' && this.planFor(task)?.plan_approved_at)
      check(
        !['description', 'acceptance_criteria', 'depends_on', 'repository'].some((k) => k in p),
        'plan_scope_locked',
        'The approved scope cannot be changed.',
        'Create a follow-up plan for changes to scope, criteria, dependencies or repository.',
      );
    if (p.criteria_check !== undefined) this.reviewer(actor, task);
    if (
      p.criteria_check === undefined ||
      Object.keys(p).some((k) => !['id', 'criteria_check', 'note'].includes(k))
    )
      this.taskActor(actor, task);
    check(
      !terminal(task),
      'task_closed',
      'Closed tasks are immutable.',
      'Create a follow-up task.',
    );
    const before = task;
    if (p.repository !== undefined && p.repository !== task.repository) {
      if (task.repository) this.human(actor);
      check(
        this.taskLock(task).task_id !== task.id,
        'write_lock_held',
        'This task still holds a code-writing lock.',
        'Inspect and release the lock before selecting a repository.',
      );
      check(
        // A human may bind migrated work even if it already has review history or artifacts.
        // The old lock must still be recovered explicitly before this point.
        (!task.repository && actor.kind === 'human') ||
          (['draft', 'open', 'claimed', 'blocked'].includes(task.status) &&
            task.artifacts.length === 0 &&
            task.attempt === 0 &&
            !this.store.get(
              "SELECT 1 FROM events WHERE task_id=? AND type='task.status_changed' AND json_extract(payload,'$.to')='in_progress' LIMIT 1",
              task.id,
            )),
        'repository_locked',
        'The repository cannot change after work has started.',
        'Create a follow-up task for a different repository.',
      );
      this.store.run('UPDATE tasks SET repository=? WHERE id=?', p.repository, task.id);
      task = this.task(task.id);
    }
    const admin = [
      'title',
      'description',
      'priority',
      'assignee',
      'acceptance_criteria',
      'frozen',
      'depends_on',
    ] as const;
    if (admin.some((k) => p[k] !== undefined)) this.human(actor);
    if (p.depends_on !== undefined) {
      check(
        ['draft', 'open', 'claimed', 'blocked', 'changes_requested'].includes(task.status),
        'dependencies_locked',
        'Dependencies cannot change during work or review.',
        'Block the task before revising its dependencies.',
      );
      for (const id of p.depends_on) {
        this.task(id);
        const cycle =
          id === task.id ||
          this.store.get(
            `WITH RECURSIVE ancestors(id) AS (
          SELECT depends_on_id FROM task_dependencies WHERE task_id=? UNION
          SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
        ) SELECT 1 FROM ancestors WHERE id=?`,
            id,
            task.id,
          );
        check(
          !cycle,
          'dependency_cycle',
          'Dependencies must not form a cycle.',
          'Remove the circular dependency.',
          400,
        );
      }
      this.store.run('DELETE FROM task_dependencies WHERE task_id=?', task.id);
      for (const id of new Set(p.depends_on))
        this.store.run('INSERT INTO task_dependencies VALUES(?,?)', task.id, id);
      task = this.task(task.id);
    }
    for (const field of ['title', 'description', 'priority', 'frozen'] as const) {
      const value = p[field];
      if (value !== undefined)
        this.store.run(
          `UPDATE tasks SET ${field}=? WHERE id=?`,
          typeof value === 'boolean' ? Number(value) : value,
          task.id,
        );
    }
    if (p.assignee !== undefined && p.assignee !== task.assignee) {
      check(
        this.taskLock(task).task_id !== task.id,
        'write_lock_held',
        'This task still holds the code-writing lock.',
        'Inspect the workspace and release the lock before reassigning.',
      );
      check(
        !['draft', 'in_review'].includes(task.status),
        'cannot_reassign',
        `Cannot reassign a ${task.status} task.`,
        'Publish the draft or complete its review first.',
      );
      if (p.assignee) {
        check(
          !this.participant(p.assignee).frozen,
          'assignee_frozen',
          'The new assignee is paused.',
          'Resume them before assigning work.',
        );
        this.dependenciesDone(task);
        const count = this.store.get<{ n: number }>(
          "SELECT count(*) n FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','blocked','changes_requested') AND id!=?",
          p.assignee,
          task.id,
        )!.n;
        check(
          count < this.settings().max_in_progress,
          'task_limit',
          'The new assignee has reached the active task limit.',
          'Finish or release their current task first.',
        );
      }
      const status = p.assignee ? 'claimed' : 'open';
      this.store.run(
        "UPDATE approvals SET state='superseded',resolved_by=?,resolved_at=? WHERE task_id=? AND state='pending'",
        actor.handle,
        this.timestamp(),
        task.id,
      );
      if (task.status !== 'open')
        this.changeStatus(actor, task, 'open', p.note ?? 'Human reassignment');
      this.store.run('UPDATE tasks SET assignee=?,reviewer=NULL WHERE id=?', p.assignee, task.id);
      if (p.assignee)
        this.changeStatus(actor, this.task(task.id), 'claimed', p.note ?? 'Human reassignment');
      this.store.run(
        'UPDATE acceptance_criteria SET checked=0,checked_by=NULL WHERE task_id=?',
        task.id,
      );
      this.event(actor.handle, 'task.reassigned', task.id, {
        from: task.assignee,
        to: p.assignee,
        from_status: task.status,
        to_status: status,
      });
      this.systemMessage(
        actor,
        task.id,
        `负责人已改派：${p.assignee ? `@${p.assignee}` : '待认领'}。`,
        [task.assignee, p.assignee].filter((h): h is string => Boolean(h)),
      );
    }
    if (p.acceptance_criteria) {
      this.store.run('DELETE FROM acceptance_criteria WHERE task_id=?', task.id);
      p.acceptance_criteria.forEach((text, position) =>
        this.store.run(
          'INSERT INTO acceptance_criteria(task_id,text,position) VALUES(?,?,?)',
          task.id,
          text,
          position,
        ),
      );
    }
    for (const criterion of p.criteria_check ?? []) {
      const result = this.store.run(
        'UPDATE acceptance_criteria SET checked=?,checked_by=? WHERE id=? AND task_id=?',
        Number(criterion.checked),
        actor.handle,
        criterion.id,
        task.id,
      );
      check(
        result.changes === 1,
        'criterion_not_found',
        `Criterion ${criterion.id} does not belong to T-${task.id}.`,
        'Use get_task to read current criterion IDs.',
        400,
      );
    }
    if (p.artifacts_add) this.addArtifacts(actor, task.id, p.artifacts_add);
    task = this.task(task.id);
    if (p.status && p.status !== task.status) {
      check(
        ['open', 'in_progress', 'blocked'].includes(p.status),
        'dedicated_operation_required',
        `Use the dedicated operation to move to ${p.status}.`,
        'Use claim_task, release_task, submit_for_review, review_task or the human transition action.',
        400,
      );
      if (p.status === 'open')
        check(
          task.status === 'draft',
          'use_release',
          'Use release_task to return assigned work to open.',
          'Supply a release reason.',
        );
      else this.owner(actor, task);
      if (p.status === 'blocked') this.requireBlockReason(actor, task, p.note);
      this.changeStatus(actor, task, p.status, p.note ?? 'Task updated');
    }
    if (p.note) this.systemMessage(actor, task.id, p.note, []);
    this.renew(task.id);
    this.store.run('UPDATE tasks SET updated_at=? WHERE id=?', this.timestamp(), task.id);
    const updated = this.task(task.id);
    this.event(actor.handle, 'task.updated', task.id, { before, after: updated });
    return updated;
  }
  private requireBlockReason(actor: Participant, task: Task, note: string | undefined): void {
    check(
      note,
      'block_reason_required',
      'A blocked task needs a reason.',
      'Explain the blocker and @mention someone who can help.',
      400,
    );
    const mentions = this.resolveMentions(note, [], task.id);
    check(
      actor.kind === 'human' || mentions.some((h) => h !== actor.handle),
      'block_mention_required',
      'The blocker must notify another participant.',
      'Mention @human or the participant who can unblock you.',
      400,
    );
  }
  private releaseTask(actor: Participant, p: Parsed<'release_task'>): Task {
    const task = this.task(p.id);
    this.owner(actor, task);
    check(
      activeStatuses.includes(task.status),
      'cannot_release',
      `A ${task.status} task cannot be released.`,
      'Release only assigned work that has not been submitted.',
    );
    check(
      this.taskLock(task).task_id !== task.id,
      'write_lock_held',
      'This task still holds the write lock.',
      'Ask @human to inspect the working tree and release the code lock first.',
    );
    check(
      actor.kind === 'human' || !isGated(this.settings(), task.status, 'open', task.type),
      'approval_required',
      'Releasing this task requires human approval.',
      'Request approval to move to open.',
      403,
    );
    this.changeStatus(actor, task, 'open', p.reason);
    this.store.run(
      "UPDATE tasks SET status='open',assignee=NULL,reviewer=NULL,lease_until=NULL,lease_expired_at=NULL,updated_at=? WHERE id=?",
      this.timestamp(),
      task.id,
    );
    this.store.run(
      "UPDATE approvals SET state='superseded',resolved_at=?,resolved_by=? WHERE task_id=? AND state='pending'",
      this.timestamp(),
      actor.handle,
      task.id,
    );
    this.systemMessage(actor, task.id, `任务已释放：${p.reason}`, [task.creator]);
    this.event(actor.handle, 'task.released', task.id, {
      from: task.status,
      to: 'open',
      previous_assignee: task.assignee,
      reason: p.reason,
    });
    return this.task(task.id);
  }
  private submit(actor: Participant, p: Parsed<'submit_for_review'>, runId?: string): Task {
    const task = this.task(p.id);
    this.owner(actor, task);
    check(
      task.status === 'in_progress',
      'cannot_submit',
      'Only an in-progress task can be submitted.',
      'Start or resume the task before submitting.',
    );
    if (p.reviewer) {
      this.participant(p.reviewer);
      check(
        p.reviewer !== task.assignee,
        'self_review',
        'The assignee cannot review their own work.',
        'Choose another reviewer.',
        403,
      );
    }
    if (task.writes_code) {
      const lock = this.taskLock(task);
      check(
        lock.task_id === task.id && lock.holder === task.assignee,
        'write_lock_required',
        'This task does not hold the code-writing lock.',
        'Resume the task with update_task to acquire the lock.',
      );
      const commits = p.artifacts.filter((a) => a.kind === 'commit');
      check(
        commits.length === 1,
        'commit_required',
        'Code submission requires exactly one commit artifact.',
        'Commit your work and attach its full SHA.',
        400,
      );
    }
    this.addArtifacts(actor, task.id, p.artifacts);
    this.store.run('UPDATE tasks SET reviewer=? WHERE id=?', p.reviewer ?? null, task.id);
    this.changeStatus(actor, task, 'in_review', p.summary);
    this.event(actor.handle, 'task.submitted', task.id, {
      commit_sha: p.artifacts.find((a) => a.kind === 'commit')?.ref ?? null,
      run_id: runId ?? null,
    });
    const reviewers = p.reviewer ? [p.reviewer] : [task.creator];
    if (isGated(this.settings(), 'in_review', 'done', task.type)) reviewers.push('human');
    this.systemMessage(actor, task.id, `提交验收：${p.summary}`, reviewers, 'handoff', runId);
    return this.task(task.id);
  }
  private review(actor: Participant, p: Parsed<'review_task'>): Task {
    const task = this.task(p.id);
    this.reviewer(actor, task);
    const next = p.verdict === 'approve' ? 'done' : 'changes_requested';
    if (next === 'done')
      check(
        task.acceptance_criteria.every((c) => c.checked),
        'criteria_incomplete',
        'Some acceptance criteria are unchecked.',
        'Verify and check each criterion before approving.',
      );
    this.changeStatus(actor, task, next, p.comments);
    if (next === 'changes_requested') {
      this.store.run(
        'UPDATE acceptance_criteria SET checked=0,checked_by=NULL WHERE task_id=?',
        task.id,
      );
      this.store.run('UPDATE tasks SET attempt=attempt+1 WHERE id=?', task.id);
      if (task.attempt + 1 >= this.settings().max_attempts) {
        // Escalation is an automatic safety stop, independent of optional approval gates.
        this.store.run(
          "UPDATE tasks SET status='blocked',lease_until=NULL,lease_expired_at=NULL WHERE id=?",
          task.id,
        );
        this.event(actor.handle, 'task.escalated', task.id, {
          from: 'changes_requested',
          to: 'blocked',
          attempt: task.attempt + 1,
          reason: 'Review attempt limit reached',
        });
        this.systemMessage(
          actor,
          task.id,
          `已达到返工上限（${task.attempt + 1} 次），请人工决定下一步。`,
          ['human', task.creator, ...(task.assignee ? [task.assignee] : [])],
        );
      }
    }
    this.systemMessage(
      actor,
      task.id,
      `${next === 'done' ? '验收通过' : '请求修改'}：${p.comments}`,
      task.assignee ? [task.assignee] : [],
    );
    return this.task(task.id);
  }
  private reviewer(actor: Participant, task: Task): void {
    this.writable(actor, task);
    check(
      task.status === 'in_review',
      'not_in_review',
      `T-${task.id} is not awaiting review.`,
      'Wait for the assignee to submit work.',
    );
    check(
      task.assignee !== actor.handle,
      'self_review',
      'You cannot review your own work.',
      'Ask another reviewer or @human.',
      403,
    );
    check(
      actor.kind === 'human' ||
        task.reviewer === actor.handle ||
        task.creator === actor.handle ||
        (!task.reviewer && ['planner', 'tester', 'reviewer'].includes(actor.role ?? '')),
      'reviewer_required',
      'You are not a reviewer for this task.',
      'Ask the assigned reviewer or @human.',
      403,
    );
  }
  private requestApproval(actor: Participant, p: Parsed<'request_approval'>): Approval {
    const task = this.task(p.id);
    if (task.type === 'merge' && p.to_status === 'open') this.dependenciesDone(task);
    const eligibleReviewer =
      task.status === 'in_review' &&
      actor.handle !== task.assignee &&
      (task.reviewer === actor.handle ||
        task.creator === actor.handle ||
        (!task.reviewer && ['planner', 'tester', 'reviewer'].includes(actor.role ?? '')));
    if (eligibleReviewer) this.writable(actor, task);
    else this.taskActor(actor, task);
    check(
      transitions[task.status].includes(p.to_status) &&
        isGated(this.settings(), task.status, p.to_status, task.type),
      'not_approval_gate',
      'This is not a configured approval transition.',
      'Read get_settings and use the regular task action.',
    );
    const existing = this.store.get<Approval>(
      "SELECT * FROM approvals WHERE task_id=? AND to_status=? AND state='pending'",
      task.id,
      p.to_status,
    );
    if (existing) return existing;
    const r = this.store.run(
      'INSERT INTO approvals(task_id,requester,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?)',
      task.id,
      actor.handle,
      task.status,
      p.to_status,
      p.reason,
      this.timestamp(),
    );
    this.systemMessage(
      actor,
      task.id,
      `申请人工审批：${task.status} → ${p.to_status}。${p.reason}`,
      ['human'],
    );
    this.event(actor.handle, 'approval.requested', task.id, {
      id: r.id,
      from: task.status,
      to: p.to_status,
      reason: p.reason,
    });
    return this.store.get<Approval>('SELECT * FROM approvals WHERE id=?', r.id)!;
  }
  private transitionTask(actor: Participant, p: Parsed<'transition_task'>): Task {
    this.human(actor);
    const task = this.task(p.id);
    if (task.type === 'merge' && task.status === 'draft' && p.status === 'open')
      this.dependenciesDone(task);
    if (task.type === 'plan' && p.status === 'cancelled')
      check(
        !this.store.get(
          "SELECT 1 FROM tasks WHERE parent_id=? AND status NOT IN ('done','cancelled')",
          task.id,
        ),
        'plan_has_active_tasks',
        'This plan still has active children.',
        'Cancel or finish its child tasks first.',
      );
    if (
      this.settings().approval_mode === 'plan' &&
      task.workflow_plan &&
      task.status === 'draft' &&
      p.status === 'open'
    ) {
      const scope = this.store
        .all<{ writes_code: number; repository: string | null; status: string }>(
          `WITH RECURSIVE scope(id,writes_code,repository,status) AS (
        SELECT id,writes_code,repository,status FROM tasks WHERE parent_id=? UNION ALL
        SELECT t.id,t.writes_code,t.repository,t.status FROM tasks t JOIN scope s ON t.parent_id=s.id
      ) SELECT * FROM scope`,
          task.id,
        )
        .filter((t) => t.status !== 'cancelled');
      check(
        scope.length > 0 && scope.every((t) => !t.writes_code || t.repository),
        'plan_scope_incomplete',
        'The plan needs child tasks with repositories selected for all code work.',
        'Finish defining the scope before approving the plan.',
      );
      this.store.run(
        'UPDATE tasks SET plan_approved_at=?,plan_approved_by=? WHERE id=?',
        this.timestamp(),
        actor.handle,
        task.id,
      );
      this.event(actor.handle, 'plan.approved', task.id, { reason: p.reason });
    }
    switch (p.status) {
      case 'done':
        return this.review(actor, { id: p.id, verdict: 'approve', comments: p.reason });
      case 'changes_requested':
        return this.review(actor, { id: p.id, verdict: 'changes_requested', comments: p.reason });
      case 'in_review':
        return this.submit(actor, { id: p.id, summary: p.reason, artifacts: p.artifacts ?? [] });
      case 'claimed':
        return this.claim(actor, p.id);
      case 'open':
        if (task.status !== 'draft') return this.releaseTask(actor, { id: p.id, reason: p.reason });
        break;
      case 'blocked':
        this.requireBlockReason(actor, task, p.reason);
        break;
    }
    this.changeStatus(actor, task, p.status, p.reason);
    this.systemMessage(actor, task.id, `人工操作：${p.reason}`, [
      ...new Set([task.creator, ...(task.assignee ? [task.assignee] : [])]),
    ]);
    return this.task(task.id);
  }
  private resolveMentions(body: string, explicit: string[], taskId: number | null): string[] {
    const strict = new Set(explicit.map((h) => h.replace(/^@/, '')));
    const participants = this.store
      .all<ParticipantRow>(`SELECT ${participantColumns} FROM participants WHERE enabled=1`)
      .map((p) => this.publicParticipant(p));
    const names = new Set([
      ...Array.from(
        body.matchAll(/(?:^|[^\w@])@([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)?)(?![a-z0-9_:/-])/g),
        (m) => m[1]!,
      ),
      ...strict,
    ]);
    const handles = new Set<string>();
    for (const name of names) {
      if (name === 'human')
        participants.filter((p) => p.kind === 'human').forEach((p) => handles.add(p.handle));
      else if (name.startsWith('role:')) {
        const role = name.slice(5);
        const known = participants.some((p) => p.kind === 'agent' && p.role === role);
        if (!known && !strict.has(name)) continue;
        check(
          known,
          'unknown_role',
          `No agent has role ${role}.`,
          'Use list_participants to inspect roles.',
          400,
        );
        participants
          .filter(
            (p) => p.kind === 'agent' && p.role === role && p.status !== 'offline' && !p.frozen,
          )
          .forEach((p) => handles.add(p.handle));
      } else if (name === 'assignee') {
        if ((!taskId || !this.task(taskId).assignee) && !strict.has(name)) continue;
        check(
          taskId,
          'assignee_context_required',
          '@assignee requires a task discussion.',
          'Post to a task_id or mention a specific handle.',
          400,
        );
        const assignee = this.task(taskId).assignee;
        check(
          assignee,
          'assignee_missing',
          'This task has no assignee to mention.',
          'Mention its creator or @human.',
          400,
        );
        handles.add(assignee);
      } else {
        if (!participants.some((p) => p.handle === name) && !strict.has(name)) continue;
        this.participant(name);
        handles.add(name);
      }
    }
    return [...handles];
  }
  private systemMessage(
    actor: Participant,
    taskId: number,
    body: string,
    mentions: string[],
    kind = 'system',
    runId?: string,
  ): Message {
    return this.insertMessage(actor, {
      taskId,
      runId,
      channelId: null,
      body,
      kind,
      mentions: this.resolveMentions(
        body,
        mentions.filter(
          (h) =>
            ['human', 'assignee'].includes(h) ||
            h.startsWith('role:') ||
            this.store.get('SELECT 1 FROM participants WHERE handle=? AND enabled=1', h),
        ),
        taskId,
      ),
      replyTo: null,
    });
  }
  private channel(
    actor: Participant,
    channelName?: string,
    to?: string,
    create = false,
  ): Channel | undefined {
    if (to) {
      this.participant(to);
      check(
        to !== actor.handle,
        'dm_self',
        'Choose another participant for a direct message.',
        'Use your task discussion for personal notes.',
        400,
      );
    }
    const name = to ? `dm:${[actor.handle, to].sort().join(':')}` : channelName!;
    let channel = this.store.get<Channel>('SELECT * FROM channels WHERE name=?', name);
    if (!channel && create) {
      const result = this.store.run(
        'INSERT INTO channels(name,kind) VALUES(?,?)',
        name,
        to ? 'dm' : 'channel',
      );
      channel = { id: result.id, name, kind: to ? 'dm' : 'channel' };
      if (to)
        for (const handle of [actor.handle, to])
          this.store.run('INSERT INTO channel_members VALUES(?,?)', channel.id, handle);
      this.event(
        actor.handle,
        'channel.created',
        null,
        { channel },
        to ? [actor.handle, to] : null,
      );
    }
    if (channel?.kind === 'dm')
      check(
        this.store.get(
          'SELECT 1 FROM channel_members WHERE channel_id=? AND handle=?',
          channel.id,
          actor.handle,
        ),
        'private_thread',
        'This conversation is private.',
        'Read a conversation you participate in.',
        403,
      );
    return channel;
  }
  private insertMessage(
    actor: Participant,
    p: {
      taskId: number | null;
      channelId: number | null;
      body: string;
      kind: string;
      mentions: string[];
      replyTo: number | null;
      runId?: string;
    },
  ): Message {
    let audience: string[] | null = null;
    if (
      p.channelId &&
      this.store.get<Channel>('SELECT * FROM channels WHERE id=?', p.channelId)?.kind === 'dm'
    ) {
      audience = this.store
        .all<{
          handle: string;
        }>('SELECT handle FROM channel_members WHERE channel_id=?', p.channelId)
        .map((r) => r.handle);
      check(
        p.mentions.every((h) => audience!.includes(h)),
        'private_mention',
        'A private message cannot mention someone outside the conversation.',
        'Use a public task or channel to include additional participants.',
        400,
      );
    }
    if (p.replyTo) {
      const original = this.store.get<Message>('SELECT * FROM messages WHERE id=?', p.replyTo);
      check(
        original && original.task_id === p.taskId && original.channel_id === p.channelId,
        'invalid_reply',
        'The replied-to message is not in this discussion.',
        'Read the thread and choose a message from it.',
        400,
      );
      if (original.kind === 'question')
        this.store.run(
          "UPDATE mentions SET state='resolved' WHERE message_id=? AND handle=?",
          p.replyTo,
          actor.handle,
        );
      if (!p.mentions.includes(original.author)) p.mentions.push(original.author);
    }
    const r = this.store.run(
      'INSERT INTO messages(author,task_id,channel_id,kind,body,reply_to,created_at,run_id) VALUES(?,?,?,?,?,?,?,?)',
      actor.handle,
      p.taskId,
      p.channelId,
      p.kind,
      p.body,
      p.replyTo,
      this.timestamp(),
      p.runId ?? null,
    );
    for (const handle of new Set(p.mentions))
      this.store.run(
        'INSERT INTO mentions(message_id,handle,created_at) VALUES(?,?,?)',
        r.id,
        handle,
        this.timestamp(),
      );
    const message = this.store.get<Message>('SELECT * FROM messages WHERE id=?', r.id)!;
    this.event(
      actor.handle,
      'message.posted',
      p.taskId,
      { message, mentions: p.mentions },
      audience,
    );
    return message;
  }
  private postMessage(actor: Participant, p: Parsed<'post_message'>, runId?: string): Message {
    if (actor.kind === 'agent') {
      const since = new Date(this.now() - 60000).toISOString();
      const count = this.store.get<{ n: number }>(
        "SELECT count(*) n FROM events WHERE actor=? AND type='message.posted' AND created_at>?",
        actor.handle,
        since,
      )!.n;
      check(
        count < this.settings().message_rate_per_minute,
        'message_rate_limit',
        'You have reached the message rate limit.',
        'Wait one minute or consolidate your questions into one message.',
        429,
      );
    }
    if (p.task_id) this.writable(actor, this.task(p.task_id));
    const channel = p.task_id ? undefined : this.channel(actor, p.channel, p.to, true);
    return this.insertMessage(actor, {
      taskId: p.task_id ?? null,
      channelId: channel?.id ?? null,
      body: p.body,
      kind: p.kind,
      mentions: this.resolveMentions(
        p.body,
        [...p.mentions, ...(p.to ? [p.to] : [])],
        p.task_id ?? null,
      ),
      replyTo: p.reply_to ?? null,
      runId,
    });
  }
  private thread(actor: Participant, p: Parsed<'get_thread'>): Message[] {
    if (p.task_id) this.task(p.task_id);
    const channel = p.task_id ? undefined : this.channel(actor, p.channel, p.to);
    if (!p.task_id && !channel) return [];
    const rows = this.store.all<Message>(
      `SELECT * FROM messages WHERE ${p.task_id ? 'task_id' : 'channel_id'}=? AND id>? ORDER BY id ${p.since ? 'ASC' : 'DESC'} LIMIT ?`,
      p.task_id ?? channel!.id,
      p.since,
      p.limit,
    );
    return p.since ? rows : rows.reverse();
  }
  private inbox(actor: Participant, input: Input<'check_inbox'>): Mention[] {
    const p = schemas.check_inbox.parse(input);
    const rows = this.store.all<Omit<Mention, 'message'>>(
      `SELECT id,message_id,state,created_at FROM mentions WHERE handle=? AND id>? ${p.unread_only ? "AND state='unread'" : ''}
      AND (? IS NULL OR id<?) AND (? IS NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.id=mentions.message_id AND m.kind=?))
      ORDER BY id ${p.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      actor.handle,
      p.since,
      p.before ?? null,
      p.before ?? null,
      p.kind ?? null,
      p.kind ?? null,
      p.limit,
    );
    return rows.map((r) => ({
      ...r,
      message: this.store.get<Message>(
        'SELECT m.*,c.name channel_name FROM messages m LEFT JOIN channels c ON c.id=m.channel_id WHERE m.id=?',
        r.message_id,
      )!,
    }));
  }
  events(actor: Participant, input: Input<'get_events'>): BoardEvent[] {
    const p = schemas.get_events.parse(input);
    const where = [
      'id>?',
      '(audience IS NULL OR EXISTS(SELECT 1 FROM json_each(events.audience) WHERE value=?))',
    ];
    const params: SQLInputValue[] = [p.since, actor.handle];
    if (p.before !== undefined) {
      where.push('id<?');
      params.push(p.before);
    }
    // Older databases may contain heartbeat events; keep them available for explicit audit queries.
    if (p.order === 'desc' && p.type === undefined) where.push("type!='agent.heartbeat'");
    for (const [col, val] of [
      ['task_id', p.task_id],
      ['actor', p.actor],
      ['type', p.type],
    ] as const)
      if (val !== undefined) {
        where.push(`${col}=?`);
        params.push(val);
      }
    return this.store
      .all<EventRow>(
        `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ${p.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        ...params,
        p.limit,
      )
      .map(({ audience: _audience, ...row }) => ({
        ...row,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }));
  }
  private approvals(): Approval[] {
    return this.store.all<Approval>(
      "SELECT a.*,t.title FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE a.state='pending' ORDER BY a.id",
    );
  }
  private overview(actor: Participant): Overview {
    return {
      counts: Object.fromEntries(
        this.store
          .all<{ status: string; n: number }>('SELECT status,count(*) n FROM tasks GROUP BY status')
          .map((r) => [r.status, r.n]),
      ),
      locks: this.store.all<WriteLock>(
        "SELECT nullif(repository,'') repository,holder,task_id,acquired_at FROM write_locks ORDER BY repository",
      ),
      repositories: this.store
        .all<{
          repository: string;
        }>(
          "SELECT repository FROM tasks WHERE repository IS NOT NULL UNION SELECT repository FROM write_locks WHERE repository!='' ORDER BY repository",
        )
        .map((r) => r.repository),
      participants: this.participants(),
      approvals: this.approvals(),
      unread: this.unread(actor.handle),
      attention: this.store
        .all<TaskRow>(
          "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') AND (status='blocked' OR lease_expired_at IS NOT NULL OR frozen=1) ORDER BY priority,id",
        )
        .map((t) => this.summary(t)),
      event_cursor: this.eventCursor(),
    };
  }
  sweep(): void {
    const now = this.timestamp();
    const cutoff = new Date(this.now() - 90000).toISOString();
    this.transaction(() => {
      for (const run of this.store.all<WorkerRun>(
        "SELECT * FROM worker_runs WHERE state='active' AND lease_until<=?",
        now,
      ))
        this.stopRun(
          this.participant(run.handle, true),
          run,
          'Worker 连接已过期，工作目录和锁已保留；请协调者确认旧进程停止后重新派发。',
          'expired',
        );
      for (const row of this.store.all<ParticipantRow>(
        `SELECT ${participantColumns} FROM participants WHERE kind='agent' AND status!='offline' AND NOT EXISTS(SELECT 1 FROM sessions WHERE sessions.handle=participants.handle AND sessions.last_seen_at>?)`,
        cutoff,
      )) {
        this.store.run("UPDATE participants SET status='offline' WHERE handle=?", row.handle);
        this.event(null, 'agent.offline', null, {
          handle: row.handle,
          reason: 'inactive',
        });
      }
      const expired = this.store.all<TaskRow>(
        "SELECT * FROM tasks WHERE lease_until<=? AND lease_expired_at IS NULL AND status IN ('claimed','in_progress','changes_requested')",
        now,
      );
      for (const row of expired) {
        const actor = this.participant(row.assignee!, true);
        if (this.taskLock(row).task_id === row.id) {
          this.store.run(
            'UPDATE tasks SET lease_expired_at=?,updated_at=? WHERE id=?',
            now,
            now,
            row.id,
          );
          this.event(null, 'task.lease_expired_locked', row.id, {
            assignee: row.assignee,
            lease_until: row.lease_until,
          });
          this.systemMessage(
            actor,
            row.id,
            '任务租约已到期，写入锁仍保留。请人工检查工作目录后决定恢复或释放。',
            ['human', row.creator],
          );
        } else {
          this.store.run(
            "UPDATE tasks SET status='open',assignee=NULL,reviewer=NULL,lease_until=NULL,lease_expired_at=NULL,updated_at=? WHERE id=?",
            now,
            row.id,
          );
          this.store.run(
            "UPDATE approvals SET state='superseded',resolved_at=? WHERE task_id=? AND state='pending'",
            now,
            row.id,
          );
          this.event(null, 'task.lease_expired', row.id, {
            from: row.status,
            to: 'open',
            previous_assignee: row.assignee,
          });
          this.systemMessage(actor, row.id, '任务租约已到期，已返回待认领队列。', [
            'human',
            row.creator,
          ]);
        }
      }
    });
  }
  leave(actor: Participant, sessionId: string | undefined): Envelope<Participant> {
    check(
      actor.kind === 'agent' && sessionId,
      'agent_required',
      'Only an agent session can leave.',
      'Use the session ID returned by join.',
      403,
    );
    return this.transaction(() => {
      this.store.run('DELETE FROM sessions WHERE id=? AND handle=?', sessionId, actor.handle);
      const cutoff = new Date(this.now() - 90000).toISOString();
      if (
        !this.store.get(
          'SELECT 1 FROM sessions WHERE handle=? AND last_seen_at>?',
          actor.handle,
          cutoff,
        )
      )
        this.store.run("UPDATE participants SET status='offline' WHERE handle=?", actor.handle);
      this.event(actor.handle, 'agent.left', null, { handle: actor.handle, session_id: sessionId });
      return { data: this.participant(actor.handle), unread: this.unread(actor.handle) };
    });
  }
  async execute(actor: Participant, operation: Operation, input: unknown): Promise<Envelope> {
    const parsed = schemas[operation].parse(input);
    const write = operations[operation].method !== 'GET';
    let evidence: Evidence[] = [];
    let preparedEvidence: PreparedEvidence | undefined;
    // Resolve caller paths outside SQLite transactions. No server-wide current repository exists.
    if ('repository' in parsed && typeof parsed.repository === 'string') {
      if (write) this.writable(this.participant(actor.handle));
      if (operations[operation].human) this.human(actor);
      // Existing canonical paths still allow inspection/release if a working tree has been removed.
      const existingLock =
        ['get_lock', 'release_lock'].includes(operation) && this.lock(parsed.repository).holder;
      if (!existingLock)
        parsed.repository = await (this.options.resolveRepository ?? resolveRepository)(
          parsed.repository,
        );
    }
    const perform = (): unknown => {
      // Re-read permissions inside the mutation transaction; clients never own policy.
      actor = this.participant(actor.handle);
      if (write) this.writable(actor);
      if (operations[operation].human) this.human(actor);
      switch (operation) {
        case 'dispatch_task':
          return this.dispatch(actor, schemas.dispatch_task.parse(parsed));
        case 'complete_plan':
          return this.completePlan(actor, schemas.complete_plan.parse(parsed));
        case 'stop_worker': {
          const p = schemas.stop_worker.parse(parsed);
          const run = this.run(p.run_id);
          check(
            actor.kind === 'human' || actor.handle === run.coordinator,
            'coordinator_required',
            'Only the coordinator can stop this worker.',
            'Ask the coordinator to stop it.',
            403,
          );
          return run.state === 'active' ? this.stopRun(actor, run, p.reason) : this.assignment(run);
        }
        case 'worker_get_task':
        case 'worker_heartbeat':
        case 'worker_post_message':
        case 'worker_submit':
        case 'worker_review':
          return this.workerOperation(actor, operation, parsed, evidence);
        case 'worker_prepare_evidence':
          this.activeRun(actor, schemas.worker_prepare_evidence.parse(parsed).run_id);
          return preparedEvidence;
        case 'join':
        case 'leave':
          throw new Error('Session operations require the HTTP session entry point.');
        case 'whoami':
          return {
            participant: actor,
            tasks: this.listTasks(actor, { mine: true, limit: 200, offset: 0 }).filter(
              (t) => !terminal(t),
            ),
            unread: this.unread(actor.handle),
            pending: this.pending(actor),
          } satisfies Identity;
        case 'update_profile': {
          const { display_name } = schemas.update_profile.parse(parsed);
          this.store.run(
            'UPDATE participants SET display_name_override=? WHERE handle=?',
            display_name,
            actor.handle,
          );
          this.event(actor.handle, 'participant.updated', null, {
            display_name: display_name || null,
          });
          return this.participant(actor.handle);
        }
        case 'get_overview':
          return this.overview(actor);
        case 'list_participants':
          return this.participants();
        case 'get_settings':
          return this.settings();
        case 'put_settings': {
          const before = this.settings();
          const next = settingsSchema.parse({ ...before, ...parsed });
          this.store.run("UPDATE settings SET value=? WHERE key='policy'", JSON.stringify(next));
          for (const approval of this.approvals()) {
            const task = this.task(approval.task_id);
            if (!isGated(next, approval.from_status, approval.to_status, task.type))
              this.store.run(
                "UPDATE approvals SET state='superseded',resolved_by=?,resolved_at=? WHERE id=?",
                actor.handle,
                this.timestamp(),
                approval.id,
              );
          }
          this.event(actor.handle, 'settings.updated', null, { before, after: next });
          return next;
        }
        case 'set_status': {
          const p = schemas.set_status.parse(parsed);
          this.store.run(
            'UPDATE participants SET status=?,status_note=? WHERE handle=?',
            p.status,
            p.note ?? null,
            actor.handle,
          );
          this.event(actor.handle, 'agent.status_changed', null, {
            from: actor.status,
            to: p.status,
            note: p.note,
          });
          return this.participant(actor.handle);
        }
        case 'list_tasks':
          return this.listTasks(actor, schemas.list_tasks.parse(parsed));
        case 'list_task_runs':
          return this.taskRuns(schemas.list_task_runs.parse(parsed));
        case 'get_attention_queue':
          return this.attentionQueue(actor, schemas.get_attention_queue.parse(parsed));
        case 'get_task': {
          const p = schemas.get_task.parse(parsed);
          const task = this.task(p.id);
          if (p.include_thread)
            task.thread = this.thread(actor, { task_id: p.id, since: 0, limit: 100 });
          return { ...task, handoff: this.handoff(task) };
        }
        case 'create_task':
          return this.createTask(actor, schemas.create_task.parse(parsed));
        case 'claim_task':
          return this.claim(actor, schemas.claim_task.parse(parsed).id);
        case 'claim_next':
          return this.claimNext(actor, schemas.claim_next.parse(parsed));
        case 'update_task':
          return this.updateTask(actor, schemas.update_task.parse(parsed));
        case 'release_task':
          return this.releaseTask(actor, schemas.release_task.parse(parsed));
        case 'submit_for_review':
          return this.submit(actor, schemas.submit_for_review.parse(parsed));
        case 'review_task':
          return this.review(actor, schemas.review_task.parse(parsed));
        case 'request_approval':
          return this.requestApproval(actor, schemas.request_approval.parse(parsed));
        case 'transition_task':
          return this.transitionTask(actor, schemas.transition_task.parse(parsed));
        case 'list_approvals':
          return this.approvals();
        case 'reject_approval': {
          const p = schemas.reject_approval.parse(parsed);
          const approval = this.store.get<Approval>(
            "SELECT * FROM approvals WHERE id=? AND state='pending'",
            p.id,
          );
          check(
            approval,
            'approval_not_pending',
            'This approval request is no longer pending.',
            'Refresh the approval queue.',
          );
          this.store.run(
            "UPDATE approvals SET state='rejected',resolved_by=?,resolved_at=? WHERE id=?",
            actor.handle,
            this.timestamp(),
            p.id,
          );
          this.systemMessage(actor, approval.task_id, `审批申请被驳回：${p.reason}`, [
            approval.requester,
          ]);
          this.event(actor.handle, 'approval.rejected', approval.task_id, {
            id: p.id,
            reason: p.reason,
          });
          return { id: p.id, state: 'rejected' };
        }
        case 'post_message':
          return this.postMessage(actor, schemas.post_message.parse(parsed));
        case 'get_thread':
          return this.thread(actor, schemas.get_thread.parse(parsed));
        case 'check_inbox':
          return this.inbox(actor, schemas.check_inbox.parse(parsed));
        case 'wait_inbox': {
          const p = schemas.wait_inbox.parse(parsed);
          return this.inbox(actor, { unread_only: true, limit: 200, since: p.since });
        }
        case 'mark_read': {
          const p = schemas.mark_read.parse(parsed);
          for (const id of p.ids) {
            check(
              this.store.get('SELECT 1 FROM mentions WHERE id=? AND handle=?', id, actor.handle),
              'mention_not_found',
              'A mention does not belong to your inbox.',
              'Use check_inbox to find your mention IDs.',
              404,
            );
            this.store.run(
              `UPDATE mentions SET state=? WHERE id=? AND state!='resolved'`,
              p.resolve ? 'resolved' : 'read',
              id,
            );
          }
          this.event(
            actor.handle,
            'inbox.updated',
            null,
            { ids: p.ids, state: p.resolve ? 'resolved' : 'read' },
            [actor.handle],
          );
          return { ids: p.ids };
        }
        case 'list_channels':
          return this.store.all<Channel>(
            "SELECT * FROM channels WHERE kind='channel' OR id IN(SELECT channel_id FROM channel_members WHERE handle=?) ORDER BY kind,name",
            actor.handle,
          );
        case 'get_events':
          return this.events(actor, schemas.get_events.parse(parsed));
        case 'get_lock':
          return this.lock(schemas.get_lock.parse(parsed).repository);
        case 'acquire_lock': {
          const p = schemas.acquire_lock.parse(parsed);
          this.checkLegacyLock();
          const lock = this.lock(p.repository);
          check(
            !lock.holder,
            'write_lock_held',
            `@${lock.holder} already holds the code lock.`,
            'Inspect the current writer and release the lock explicitly if needed.',
          );
          this.store.run(
            'INSERT INTO write_locks(holder,acquired_at,repository) VALUES(?,?,?)',
            actor.handle,
            this.timestamp(),
            p.repository,
          );
          this.event(actor.handle, 'lock.acquired', null, {
            holder: actor.handle,
            repository: p.repository,
            reason: p.reason,
          });
          return this.lock(p.repository);
        }
        case 'release_lock': {
          const p = schemas.release_lock.parse(parsed);
          const lock = this.lock(p.repository);
          check(
            lock.holder,
            'lock_free',
            'The write lock is already free.',
            'Refresh the dashboard.',
          );
          if (lock.task_id) {
            const task = this.task(lock.task_id);
            this.store.run(
              "UPDATE tasks SET status='blocked',frozen=1,updated_at=? WHERE id=?",
              this.timestamp(),
              task.id,
            );
            this.systemMessage(
              actor,
              task.id,
              `人工释放了写入锁，任务已冻结。${p.reason}`,
              task.assignee ? [task.assignee] : [],
            );
            this.event(actor.handle, 'task.frozen', task.id, {
              from: task.status,
              to: 'blocked',
              reason: p.reason,
            });
          }
          this.store.run('DELETE FROM write_locks WHERE repository=?', p.repository ?? '');
          this.event(actor.handle, 'lock.released', lock.task_id, {
            ...lock,
            reason: p.reason,
            forced: true,
          });
          return this.lock(p.repository);
        }
        case 'freeze_participant': {
          const p = schemas.freeze_participant.parse(parsed);
          const target = this.participant(p.handle);
          check(
            target.kind === 'agent',
            'cannot_freeze_human',
            'Only agent participants can be frozen.',
            'Manage local human profiles in the configuration.',
            400,
          );
          this.store.run(
            'UPDATE participants SET frozen=? WHERE handle=?',
            Number(p.frozen),
            p.handle,
          );
          this.event(actor.handle, p.frozen ? 'agent.frozen' : 'agent.resumed', null, {
            handle: p.handle,
            reason: p.reason,
          });
          this.postMessage(actor, {
            to: p.handle,
            body: `${p.frozen ? '已暂停' : '已恢复'}：${p.reason}`,
            kind: 'decision',
            mentions: [],
          });
          return this.participant(p.handle);
        }
        case 'list_decisions': {
          const p = schemas.list_decisions.parse(parsed);
          return this.store.all<Message>(
            `SELECT m.* FROM messages m LEFT JOIN channels c ON c.id=m.channel_id WHERE m.kind='decision'
            AND (m.task_id IS NOT NULL OR c.kind='channel' OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=m.channel_id AND cm.handle=?)) ORDER BY m.id DESC LIMIT ?`,
            actor.handle,
            p.limit,
          );
        }
      }
    };
    const finish = (): Envelope => {
      const data = write ? this.transaction(perform) : perform();
      if (!write) return { data };
      const notifications = this.store.all<
        Omit<NonNullable<Envelope['notifications']>[number], 'blocks_current_operation'>
      >(
        "SELECT n.id,m.body,m.kind,m.task_id,m.run_id,m.created_at,n.state FROM mentions n JOIN messages m ON m.id=n.message_id WHERE n.handle=? AND n.state='unread' ORDER BY n.id DESC LIMIT 5",
        actor.handle,
      );
      return {
        data,
        unread: this.unread(actor.handle),
        notifications: notifications.map((n) => ({
          ...n,
          body: n.body.slice(0, 240),
          blocks_current_operation: false as const,
        })),
        urgent: null,
      };
    };
    if (operation === 'worker_prepare_evidence') {
      const p = schemas.worker_prepare_evidence.parse(parsed);
      const run = this.activeRun(actor, p.run_id);
      preparedEvidence = await prepareEvidence(
        run.evidence_directory ?? this.evidencePath(run.task_id, run.id),
        run.id,
        run.commit_sha,
        p.evidence,
        this.timestamp(),
      );
    }
    if (
      operation === 'worker_submit' ||
      operation === 'worker_review' ||
      (operation === 'dispatch_task' && schemas.dispatch_task.parse(parsed).mode === 'review')
    ) {
      const workerRun =
        'run_id' in parsed
          ? this.activeRun(
              actor,
              parsed.run_id,
              operation === 'worker_submit' ? 'implement' : 'review',
            )
          : undefined;
      const task = this.task(workerRun?.task_id ?? schemas.dispatch_task.parse(parsed).id);
      const sha =
        operation === 'worker_submit'
          ? schemas.worker_submit.parse(parsed).commit_sha
          : (workerRun?.commit_sha ?? this.submissionSha(task.id));
      const requiresGit =
        operation !== 'worker_review' || schemas.worker_review.parse(parsed).verdict === 'approve';
      if (workerRun && (operation === 'worker_submit' || operation === 'worker_review')) {
        const submission =
          operation === 'worker_submit'
            ? schemas.worker_submit.parse(parsed)
            : schemas.worker_review.parse(parsed);
        evidence = await submissionEvidence(
          workerRun.evidence_directory ?? this.evidencePath(task.id, workerRun.id),
          workerRun.id,
          sha ?? null,
          submission.evidence,
          submission.evidence_manifest,
          this.timestamp(),
        );
      }
      if (task.writes_code && requiresGit) {
        check(
          task.repository && sha,
          'commit_required',
          'This phase requires a recorded full submission SHA and repository.',
          'Submit a commit before dispatching its review.',
        );
        const revision = () =>
          this.store.get<{ id: number }>(
            'SELECT coalesce(max(id),0) id FROM events WHERE task_id=?',
            task.id,
          )!.id;
        const before = revision();
        await (this.options.verifyCommit ?? verifyCommit)(task.repository, sha);
        check(
          revision() === before,
          'task_changed',
          'The task changed during Git verification.',
          'Read the task again before retrying.',
        );
      }
    }
    if (
      operation === 'submit_for_review' ||
      (operation === 'transition_task' &&
        schemas.transition_task.parse(parsed).status === 'in_review')
    ) {
      const p =
        operation === 'submit_for_review'
          ? schemas.submit_for_review.parse(parsed)
          : schemas.transition_task.parse(parsed);
      const task = this.task(p.id);
      this.owner(actor, task);
      if (operation === 'transition_task') this.human(actor);
      check(
        task.status === 'in_progress',
        'cannot_submit',
        'Only an in-progress task can be submitted.',
        'Start or resume the task before submitting.',
      );
      if (task.writes_code) {
        check(
          this.taskLock(task).task_id === task.id && this.taskLock(task).holder === task.assignee,
          'write_lock_required',
          'This task does not hold the write lock.',
          'Resume the task to acquire the lock.',
        );
        const commits = (p.artifacts ?? []).filter((a) => a.kind === 'commit');
        check(
          commits.length === 1,
          'commit_required',
          'Code submission requires exactly one commit artifact.',
          'Attach the full SHA.',
          400,
        );
        const revision = () =>
          this.store.get<{ id: number }>(
            'SELECT coalesce(max(id),0) id FROM events WHERE task_id=?',
            task.id,
          )!.id;
        const before = revision();
        check(
          task.repository,
          'repository_required',
          'This task has no repository.',
          'Ask @human to inspect the old lock and bind a repository before submitting.',
          400,
        );
        // No SQLite transaction is held while Git runs. A concurrent task/lock change invalidates this submission.
        return Promise.resolve(
          (this.options.verifyCommit ?? verifyCommit)(task.repository, commits[0]!.ref),
        ).then(() => {
          check(
            revision() === before,
            'task_changed',
            'The task changed during Git verification.',
            'Read the task again before resubmitting.',
          );
          return finish();
        });
      }
    }
    return finish();
  }
}
