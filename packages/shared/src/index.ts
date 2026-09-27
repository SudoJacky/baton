import { z } from 'zod';

export const statuses = [
  'draft',
  'open',
  'claimed',
  'in_progress',
  'blocked',
  'in_review',
  'changes_requested',
  'done',
  'cancelled',
] as const;
export const taskTypes = [
  'plan',
  'implement',
  'test',
  'review',
  'bug',
  'question',
  'merge',
] as const;
export const statusSchema = z.enum(statuses);
export const taskTypeSchema = z.enum(taskTypes);
export const handleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, 'Use a lowercase handle, without @.')
  .refine((h) => !['human', 'assignee', 'role'].includes(h), 'This handle is reserved.');
export const idSchema = z.number().int().positive();
const limit = z.number().int().min(1).max(200).default(50);
const text = z.string().trim().min(1).max(20000);
export const artifactSchema = z
  .object({
    kind: z.enum(['branch', 'commit', 'pr', 'file', 'url']),
    ref: text,
    label: z.string().max(200).optional(),
  })
  .strict();
export const evidenceSchema = z
  .object({
    path: z.string().trim().min(1).max(4096),
    command: z.array(z.string()).min(1).max(200).optional(),
    exit_code: z.number().int().optional(),
    scope: text,
  })
  .strict();
export type EvidenceInput = z.infer<typeof evidenceSchema>;
export interface Evidence extends EvidenceInput {
  run_id: string;
  commit_sha: string | null;
  sha256: string;
  size_bytes: number;
  recorded_at: string;
}
export const gateSchema = z
  .object({ from: statusSchema, to: statusSchema, types: z.array(taskTypeSchema).min(1) })
  .strict();
export const settingsSchema = z
  .object({
    approval_mode: z.enum(['plan', 'custom']).default('plan'),
    merge_approval: z.boolean().default(false),
    gates: z.array(gateSchema).default([
      { from: 'draft', to: 'open', types: ['implement'] },
      { from: 'in_review', to: 'done', types: ['plan', 'implement'] },
    ]),
    lease_minutes: z.number().min(0.01).max(1440).default(30),
    max_in_progress: z.number().int().min(1).max(10).default(1),
    max_attempts: z.number().int().min(1).max(20).default(3),
    message_rate_per_minute: z.number().int().min(1).max(1000).default(30),
    roles: z.record(z.string(), z.array(taskTypeSchema)).default({
      planner: [...taskTypes],
      implementer: ['bug', 'question'],
      tester: ['bug'],
      reviewer: ['bug', 'question'],
    }),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export type TaskStatus = z.infer<typeof statusSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type ArtifactInput = z.infer<typeof artifactSchema>;

export const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['claimed', 'cancelled'],
  claimed: ['open', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['open', 'blocked', 'in_review', 'cancelled'],
  blocked: ['in_progress', 'open', 'cancelled'],
  in_review: ['done', 'changes_requested', 'cancelled'],
  changes_requested: ['open', 'in_progress', 'blocked', 'cancelled'],
  done: [],
  cancelled: [],
};
export function isGated(
  settings: Settings,
  from: TaskStatus,
  to: TaskStatus,
  type: TaskType,
): boolean {
  if (settings.approval_mode === 'plan')
    return (
      from === 'draft' &&
      to === 'open' &&
      (type === 'plan' || (type === 'merge' && settings.merge_approval))
    );
  return settings.gates.some((g) => g.from === from && g.to === to && g.types.includes(type));
}

export const schemas = {
  join: z
    .object({
      handle: handleSchema,
      role: z.string().min(1).max(100).optional(),
    })
    .strict(),
  leave: z.object({}).strict(),
  whoami: z.object({}).strict(),
  update_profile: z.object({ display_name: z.string().trim().max(80) }).strict(),
  set_status: z
    .object({
      status: z.enum(['online', 'waiting', 'offline']),
      note: z.string().max(1000).optional(),
    })
    .strict(),
  list_participants: z.object({}).strict(),
  list_tasks: z
    .object({
      search: z.string().trim().max(240).optional(),
      type: taskTypeSchema.optional(),
      depends_on: idSchema.optional(),
      status: statusSchema.optional(),
      assignee: handleSchema.optional(),
      role_hint: z.string().optional(),
      repository: z.string().trim().min(1).max(4096).optional(),
      mine: z.boolean().optional(),
      active_only: z.boolean().optional(),
      parent: idSchema.optional(),
      limit,
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  get_task: z.object({ id: idSchema, include_thread: z.boolean().default(false) }).strict(),
  list_task_runs: z
    .object({ id: idSchema, limit, offset: z.number().int().min(0).default(0) })
    .strict(),
  get_attention_queue: z
    .object({
      kind: z.enum(['all', 'approval', 'blocker', 'review', 'question']).default('all'),
      sort: z.enum(['priority', 'waiting', 'impact']).default('priority'),
      limit,
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  dispatch_task: z
    .object({ id: idSchema, handle: handleSchema, mode: z.enum(['implement', 'review']) })
    .strict(),
  stop_worker: z.object({ run_id: z.string().uuid(), reason: text }).strict(),
  complete_plan: z
    .object({
      id: idSchema,
      summary: text,
      criteria_passed: z.array(idSchema).max(100).default([]),
    })
    .strict(),
  worker_get_task: z.object({ run_id: z.string().uuid() }).strict(),
  worker_prepare_evidence: z
    .object({
      run_id: z.string().uuid(),
      evidence: z.array(evidenceSchema).max(100).default([]),
    })
    .strict(),
  worker_heartbeat: z.object({ run_id: z.string().uuid() }).strict(),
  worker_post_message: z
    .object({
      run_id: z.string().uuid(),
      body: text,
      kind: z.enum(['comment', 'question', 'report']).default('comment'),
      escalation: z.literal('merge_conflict').optional(),
    })
    .strict(),
  worker_submit: z
    .object({
      run_id: z.string().uuid(),
      summary: text,
      commit_sha: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
        .optional(),
      artifacts: z.array(artifactSchema).max(99).default([]),
      evidence: z.array(evidenceSchema).max(100).default([]),
      evidence_manifest: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  worker_review: z
    .object({
      run_id: z.string().uuid(),
      verdict: z.enum(['approve', 'changes_requested']),
      comments: text,
      criteria_passed: z.array(idSchema).max(100).default([]),
      commit_sha: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
        .optional(),
      evidence: z.array(evidenceSchema).max(100).default([]),
      evidence_manifest: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  create_task: z
    .object({
      title: z.string().trim().min(1).max(240),
      description: z.string().max(20000).default(''),
      type: taskTypeSchema,
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
      role_hint: z.string().max(100).optional(),
      parent_id: idSchema.optional(),
      repository: z.string().trim().min(1).max(4096).optional(),
      depends_on: z.array(idSchema).max(100).default([]),
      acceptance_criteria: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
      context: z.record(z.string(), z.unknown()).default({}),
      labels: z.array(z.string().min(1).max(60)).max(30).default([]),
      writes_code: z.boolean().optional(),
      draft: z.boolean().default(false),
    })
    .strict(),
  claim_task: z.object({ id: idSchema }).strict(),
  claim_next: z
    .object({
      role_hint: z.string().optional(),
      repository: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  update_task: z
    .object({
      id: idSchema,
      status: statusSchema.optional(),
      note: z.string().trim().min(1).max(20000).optional(),
      artifacts_add: z.array(artifactSchema).max(100).optional(),
      criteria_check: z.array(z.object({ id: idSchema, checked: z.boolean() }).strict()).optional(),
      title: z.string().trim().min(1).max(240).optional(),
      description: z.string().max(20000).optional(),
      acceptance_criteria: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      assignee: handleSchema.nullable().optional(),
      depends_on: z.array(idSchema).max(100).optional(),
      repository: z.string().trim().min(1).max(4096).nullable().optional(),
      frozen: z.boolean().optional(),
    })
    .strict(),
  release_task: z.object({ id: idSchema, reason: text }).strict(),
  submit_for_review: z
    .object({
      id: idSchema,
      summary: text,
      artifacts: z.array(artifactSchema).max(100).default([]),
      reviewer: handleSchema.optional(),
    })
    .strict(),
  review_task: z
    .object({ id: idSchema, verdict: z.enum(['approve', 'changes_requested']), comments: text })
    .strict(),
  request_approval: z.object({ id: idSchema, to_status: statusSchema, reason: text }).strict(),
  transition_task: z
    .object({
      id: idSchema,
      status: statusSchema,
      reason: text,
      artifacts: z.array(artifactSchema).max(100).optional(),
    })
    .strict(),
  reject_approval: z.object({ id: idSchema, reason: text }).strict(),
  list_approvals: z.object({}).strict(),
  post_message: z
    .object({
      body: text,
      task_id: idSchema.optional(),
      channel: z
        .string()
        .regex(/^[a-z0-9_-]{1,60}$/)
        .optional(),
      to: handleSchema.optional(),
      kind: z.enum(['comment', 'question', 'handoff', 'report', 'decision']).default('comment'),
      mentions: z.array(z.string().min(1).max(100)).max(100).default([]),
      reply_to: idSchema.optional(),
    })
    .strict()
    .refine(
      (v) => [v.task_id, v.channel, v.to].filter((x) => x !== undefined).length === 1,
      'Choose exactly one destination: task_id, channel, or to.',
    ),
  check_inbox: z
    .object({
      unread_only: z.boolean().default(true),
      limit,
      since: z.number().int().min(0).default(0),
      before: idSchema.optional(),
      order: z.enum(['asc', 'desc']).default('asc'),
      kind: z.enum(['comment', 'question', 'handoff', 'report', 'decision', 'system']).optional(),
    })
    .strict(),
  wait_inbox: z
    .object({
      timeout: z.number().min(0).max(60).default(60),
      since: z.number().int().min(0).default(0),
    })
    .strict(),
  mark_read: z
    .object({ ids: z.array(idSchema).min(1).max(200), resolve: z.boolean().default(false) })
    .strict(),
  get_thread: z
    .object({
      task_id: idSchema.optional(),
      channel: z.string().optional(),
      to: handleSchema.optional(),
      since: z.number().int().min(0).default(0),
      limit,
    })
    .strict()
    .refine(
      (v) => [v.task_id, v.channel, v.to].filter((x) => x !== undefined).length === 1,
      'Choose exactly one destination.',
    ),
  list_channels: z.object({}).strict(),
  get_events: z
    .object({
      since: z.number().int().min(0).default(0),
      before: idSchema.optional(),
      order: z.enum(['asc', 'desc']).default('asc'),
      task_id: idSchema.optional(),
      actor: handleSchema.optional(),
      type: z.string().optional(),
      limit,
    })
    .strict(),
  get_lock: z.object({ repository: z.string().trim().min(1).max(4096).nullable() }).strict(),
  acquire_lock: z.object({ repository: z.string().trim().min(1).max(4096), reason: text }).strict(),
  release_lock: z
    .object({ repository: z.string().trim().min(1).max(4096).nullable(), reason: text })
    .strict(),
  freeze_participant: z
    .object({ handle: handleSchema, frozen: z.boolean(), reason: text })
    .strict(),
  get_settings: z.object({}).strict(),
  put_settings: z
    .object({
      approval_mode: settingsSchema.shape.approval_mode.removeDefault().optional(),
      merge_approval: settingsSchema.shape.merge_approval.removeDefault().optional(),
      gates: settingsSchema.shape.gates.removeDefault().optional(),
      lease_minutes: settingsSchema.shape.lease_minutes.removeDefault().optional(),
      max_in_progress: settingsSchema.shape.max_in_progress.removeDefault().optional(),
      max_attempts: settingsSchema.shape.max_attempts.removeDefault().optional(),
      message_rate_per_minute: settingsSchema.shape.message_rate_per_minute
        .removeDefault()
        .optional(),
      roles: settingsSchema.shape.roles.removeDefault().optional(),
    })
    .strict(),
  get_overview: z.object({}).strict(),
  list_decisions: z.object({ limit }).strict(),
} as const;
export type Operation = keyof typeof schemas;
export type Input<K extends Operation> = z.input<(typeof schemas)[K]>;
export type Parsed<K extends Operation> = z.output<(typeof schemas)[K]>;
type Route = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  description: string;
  human?: boolean;
};
export const operations: Record<Operation, Route> = {
  list_task_runs: {
    method: 'GET',
    path: '/tasks/:id/runs',
    description:
      'Read execution and review rounds, their fixed commits, outcomes and captured evidence.',
  },
  get_attention_queue: {
    method: 'GET',
    path: '/attention',
    human: true,
    description:
      'Read pending approvals, blockers, reviews and your unresolved questions, sorted before pagination.',
  },
  dispatch_task: {
    method: 'POST',
    path: '/tasks/:id/dispatch',
    description:
      'Planner dispatches one implementation or independent review. Atomically prepares identity, claim and lock; returns a task-bound run_id for the worker. Does not launch a model.',
  },
  stop_worker: {
    method: 'POST',
    path: '/workers/:run_id/stop',
    description:
      'Coordinator stops a worker assignment after confirming its model has stopped. Preserves working files and locks.',
  },
  complete_plan: {
    method: 'POST',
    path: '/tasks/:id/complete-plan',
    description:
      'Planner closes an approved plan after all descendants have completed or been cancelled by a human.',
  },
  worker_get_task: {
    method: 'GET',
    path: '/workers/:run_id',
    description: 'Read the assigned task, discussion, review SHA and worker state.',
  },
  worker_prepare_evidence: {
    method: 'POST',
    path: '/workers/:run_id/evidence',
    description:
      "Collect this run's captured checks plus optional evidence files, validate and display the list, and create an evidence_manifest snapshot for submit/review. Does not submit or change task state.",
  },
  worker_heartbeat: {
    method: 'POST',
    path: '/workers/:run_id/heartbeat',
    description: 'Transport-managed worker lease renewal; not a model tool.',
  },
  worker_post_message: {
    method: 'POST',
    path: '/workers/:run_id/messages',
    description:
      'Post to the assigned task. Report a merge_conflict to stop integration and notify the human.',
  },
  worker_submit: {
    method: 'POST',
    path: '/workers/:run_id/submit',
    description:
      'Submit the assigned implementation with summary and full commit_sha. Attach evidence or an evidence_manifest from prepare_evidence. Server handles state and handoff.',
  },
  worker_review: {
    method: 'POST',
    path: '/workers/:run_id/review',
    description:
      'Independently review the assigned submission. verdict must be approve or changes_requested. Approve only with every verified criterion ID in criteria_passed; attach evidence or an evidence_manifest from prepare_evidence.',
  },
  join: {
    method: 'POST',
    path: '/agents/join',
    description:
      'Join Baton as an agent. Returns a non-secret session_id: keep it in this conversation and include it in every later call. To resume, reuse that ID with whoami; do not join again. Roles never grant human permissions.',
  },
  leave: {
    method: 'POST',
    path: '/agents/leave',
    description:
      'End this Baton session. Its ID stops working; assigned tasks and write locks remain unchanged.',
  },
  whoami: {
    method: 'GET',
    path: '/whoami',
    description:
      'Confirm your authenticated handle, role, assigned tasks and unread mentions before acting.',
  },
  update_profile: {
    method: 'PATCH',
    path: '/profile',
    human: true,
    description: 'Set your own display name. An empty name clears the personal greeting.',
  },
  set_status: {
    method: 'POST',
    path: '/agents/status',
    description:
      'Set your availability to online, waiting or offline. Working status is derived from active tasks.',
  },
  list_participants: {
    method: 'GET',
    path: '/participants',
    description:
      'List participants, roles, availability, current tasks and unread counts. Never returns credentials.',
  },
  list_tasks: {
    method: 'GET',
    path: '/tasks',
    description:
      'List compact task summaries with filters and pagination. Dependencies and role restrictions still apply when claiming.',
  },
  get_task: {
    method: 'GET',
    path: '/tasks/:id',
    description:
      'Read task details, acceptance criteria, dependencies and artifacts. Optionally include the latest discussion.',
  },
  create_task: {
    method: 'POST',
    path: '/tasks',
    description:
      'Create a draft plan and all its children before requesting plan approval. Code children require parent_id and an absolute repository in default plan mode. Approved scope is locked. Merge tasks start as drafts; their optional gate is controlled by merge_approval. Custom mode follows gates.',
  },
  claim_task: {
    method: 'POST',
    path: '/tasks/:id/claim',
    description:
      'Atomically claim an open unassigned task with completed dependencies and a compatible role. Returns a 30-minute lease by default.',
  },
  claim_next: {
    method: 'POST',
    path: '/tasks/claim-next',
    description:
      'Atomically claim the highest-priority eligible task. Respects dependencies, role hints and active-task limits.',
  },
  update_task: {
    method: 'PATCH',
    path: '/tasks/:id',
    description:
      'Update owner progress and renew the task lease, or check criteria as an independent reviewer while in_review. Assignees cannot check their own criteria. Select a missing repository before starting. Starting code work acquires that repository lock. Changing an existing repository requires a human and is forbidden after work starts. Blocking requires a reason with a valid @mention. Administrative fields and dependency changes require a human.',
  },
  release_task: {
    method: 'POST',
    path: '/tasks/:id/release',
    description:
      'Release an unfinished task back to open with a reason. A task holding the code lock needs human intervention; no automatic unlock of a dirty workspace.',
  },
  submit_for_review: {
    method: 'POST',
    path: '/tasks/:id/submit',
    description:
      'Submit completed work and a summary. Code-writing tasks require a commit artifact matching repository HEAD and a clean working tree. Releases the code lock only after validation succeeds.',
  },
  review_task: {
    method: 'POST',
    path: '/tasks/:id/review',
    description:
      'Approve or request changes with comments. You cannot review your own work. Configured gates require a human; repeated rejections escalate to blocked.',
  },
  request_approval: {
    method: 'POST',
    path: '/tasks/:id/approval-requests',
    description:
      'Request a configured human-gated transition. Leaves task state unchanged, records a pending request and mentions all humans.',
  },
  transition_task: {
    method: 'POST',
    path: '/tasks/:id/transition',
    description:
      'Human task transition. Bypasses approval gates, while preserving state-machine, dependency, review and write-lock invariants.',
    human: true,
  },
  reject_approval: {
    method: 'POST',
    path: '/approvals/:id/reject',
    description:
      'Reject a pending approval request with a reason. Notifies its requester and leaves task status unchanged.',
    human: true,
  },
  list_approvals: {
    method: 'GET',
    path: '/approvals',
    description: 'List pending human approval requests.',
  },
  post_message: {
    method: 'POST',
    path: '/messages',
    description:
      'Post to exactly one task, channel or private recipient. @human, @role:NAME and @assignee resolve server-side. Unknown inline mentions are ignored; explicit mentions are strictly validated. Use reply_to to answer and resolve your mention on a question.',
  },
  check_inbox: {
    method: 'GET',
    path: '/inbox',
    description:
      'Read your own inbox, unread by default. Reading does not mark messages read; use mark_read. Supports a mention-id cursor.',
  },
  wait_inbox: {
    method: 'GET',
    path: '/inbox/wait',
    description: 'Wait up to 60 seconds for unread mentions newer than a mention-id cursor.',
  },
  mark_read: {
    method: 'POST',
    path: '/inbox/mark',
    description:
      'Mark your own mention IDs read, or resolved. Cannot access another participant inbox.',
  },
  get_thread: {
    method: 'GET',
    path: '/messages',
    description:
      'Read a task, channel or your private thread. Use since for incremental reads; without since returns the latest page in chronological order.',
  },
  list_channels: {
    method: 'GET',
    path: '/channels',
    description: 'List public channels and your direct-message conversations.',
  },
  get_events: {
    method: 'GET',
    path: '/events',
    description:
      'Read the audit log with event-id cursors. Use order=desc and before for recent activity; since for replay. Private events are visible only to their audience.',
  },
  get_lock: {
    method: 'GET',
    path: '/lock',
    description:
      'Inspect a repository code-writing lock. Use repository=null only to inspect a legacy unbound lock. A blocked or expired task may still hold it.',
  },
  acquire_lock: {
    method: 'POST',
    path: '/lock/acquire',
    description:
      'Human acquires the selected repository code-writing lock before editing its files.',
    human: true,
  },
  release_lock: {
    method: 'POST',
    path: '/lock/release',
    description:
      'Human forcibly releases the selected repository lock (repository=null for a legacy unbound lock) after inspecting and preserving any working-tree changes. Suspends an active writer task.',
    human: true,
  },
  freeze_participant: {
    method: 'POST',
    path: '/participants/:handle/freeze',
    description:
      'Human freezes or resumes an agent. Frozen agents cannot perform any write operation.',
    human: true,
  },
  get_settings: {
    method: 'GET',
    path: '/settings',
    description: 'Read approval gates, task limits, lease duration and role creation permissions.',
  },
  put_settings: {
    method: 'PUT',
    path: '/settings',
    description:
      'Human updates supplied project policy fields, preserving omitted fields. Arrays and roles replace their respective field.',
    human: true,
  },
  get_overview: {
    method: 'GET',
    path: '/overview',
    description:
      'Read task counts, participants, known repositories, held locks, pending approvals and tasks needing attention.',
  },
  list_decisions: {
    method: 'GET',
    path: '/decisions',
    description: 'List recent decision messages visible to you.',
  },
};

export interface Participant {
  handle: string;
  kind: 'agent' | 'human';
  role: string | null;
  display_name: string | null;
  status: 'online' | 'working' | 'waiting' | 'offline';
  status_note: string | null;
  frozen: boolean;
  last_seen_at: string | null;
  unread?: number;
  current_tasks?: TaskSummary[];
  statistics?: {
    completed: number;
    average_completion_ms: number | null;
    reviews: number;
    rejections: number;
    rejection_rate: number | null;
  };
}
export interface TaskSummary {
  workflow_plan: boolean;
  plan_approved_at: string | null;
  plan_approved_by: string | null;
  repository: string | null;
  id: number;
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: string;
  creator: string;
  assignee: string | null;
  role_hint: string | null;
  parent_id: number | null;
  writes_code: boolean;
  attempt: number;
  frozen: boolean;
  lease_until: string | null;
  lease_expired_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Criterion {
  id: number;
  text: string;
  checked: boolean;
  checked_by: string | null;
  position: number;
}
export interface Artifact extends ArtifactInput {
  id: number;
  created_by: string;
  created_at: string;
}
export interface Task extends TaskSummary {
  description: string;
  reviewer: string | null;
  context: Record<string, unknown>;
  depends_on: number[];
  acceptance_criteria: Criterion[];
  artifacts: Artifact[];
  labels: string[];
  thread?: Message[];
  submitted_commit_sha: string | null;
  evidence: Evidence[];
  handoff?: Handoff;
}
export interface Handoff {
  summary: string;
  next_action: {
    action:
      | 'inspect_task'
      | 'none'
      | 'resolve_blocker'
      | 'wait_for_approval'
      | 'review'
      | 'implement'
      | 'dispatch_review'
      | 'inspect_and_resume'
      | 'dispatch_implement'
      | 'complete_plan'
      | 'follow_children'
      | 'request_approval';
    actor: string;
    reason: string;
  };
  blockers: { code: string; task_id: number; reason: string }[];
  lock: (WriteLock & { purpose: string }) | null;
}
export interface WorkerAssignment {
  run_id: string;
  mode: 'implement' | 'review';
  state: 'active' | 'completed' | 'stopped' | 'expired';
  handle: string;
  task: Task;
  commit_sha: string | null;
  submitted_commit_sha: string | null;
  evidence_directory: string;
  evidence: Evidence[];
  handoff: Handoff;
  heartbeat_after_ms: number;
}
export interface TaskRun {
  run_id: string;
  mode: WorkerAssignment['mode'];
  state: WorkerAssignment['state'];
  handle: string;
  coordinator: string;
  commit_sha: string | null;
  submitted_commit_sha: string | null;
  created_at: string;
  ended_at: string | null;
  summary: string | null;
  outcome: 'submitted' | 'approve' | 'changes_requested' | null;
  evidence: Evidence[];
}
export interface AttentionItem {
  id: string;
  kind: 'approval' | 'blocker' | 'review' | 'question';
  task: TaskSummary | null;
  title: string;
  reason: string;
  since: string;
  priority: string;
  impact: number;
  handoff: Handoff | null;
  mention?: Mention;
}
export interface AttentionQueue {
  items: AttentionItem[];
  total: number;
}
export interface PreparedEvidence {
  run_id: string;
  evidence_manifest: string;
  evidence: Evidence[];
}
export interface Message {
  id: number;
  author: string;
  task_id: number | null;
  channel_id: number | null;
  channel_name?: string;
  kind: string;
  body: string;
  reply_to: number | null;
  created_at: string;
  run_id?: string | null;
}
export interface Mention {
  id: number;
  message_id: number;
  state: 'unread' | 'read' | 'resolved';
  created_at: string;
  message: Message;
}
export interface BoardEvent {
  id: number;
  actor: string | null;
  type: string;
  task_id: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface WriteLock {
  repository: string | null;
  holder: string | null;
  task_id: number | null;
  acquired_at: string | null;
}
export interface Approval {
  id: number;
  task_id: number;
  requester: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  reason: string;
  state: string;
  created_at: string;
  title?: string;
}
export interface Channel {
  id: number;
  name: string;
  kind: 'channel' | 'dm';
}
export interface Overview {
  counts: Partial<Record<TaskStatus, number>>;
  participants: Participant[];
  locks: WriteLock[];
  repositories: string[];
  approvals: Approval[];
  attention: TaskSummary[];
  unread: number;
  event_cursor: number;
}
export interface Identity {
  participant: Participant;
  tasks: TaskSummary[];
  unread: number;
  pending?: { task_id: number; run_id: string | null; handoff: Handoff }[];
}
export interface AgentSession extends Identity {
  session_id: string;
}
export interface Envelope<T = unknown> {
  data: T;
  unread?: number;
  notifications?: {
    id: number;
    body: string;
    kind: string;
    task_id: number | null;
    run_id: string | null;
    created_at: string;
    state: Mention['state'];
    blocks_current_operation: false;
  }[];
  /** Kept as null for older clients; current blockers are in handoff.blockers. */
  urgent?: null;
}
export interface ApiErrorBody {
  error: { code: string; message: string; next: string; details?: unknown };
}

const profile = z
  .object({
    role: z.string().min(1).optional(),
    // Read old profiles without retaining their tool or model assignments.
    runtime: z.string().optional(),
    model: z.string().optional(),
    display_name: z.string().optional(),
  })
  .strict();
export const configSchema = z
  .object({
    url: z.string().url().default('http://127.0.0.1:4100'),
    agents: z
      .record(
        handleSchema,
        profile
          .extend({ role: z.string().min(1) })
          .transform(({ runtime: _runtime, model: _model, ...agent }) => agent),
      )
      .default({}),
    humans: z.record(
      handleSchema,
      // Accept old configuration files, but never retain or use human credentials.
      profile
        .extend({ token: z.string().optional(), token_hash: z.string().optional() })
        .transform(
          ({ token: _token, token_hash: _hash, runtime: _runtime, model: _model, ...human }) =>
            human,
        ),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!Object.keys(value.humans).length)
      ctx.addIssue({ code: 'custom', message: 'At least one human is required.' });
    if (Object.keys(value.humans).some((h) => h in value.agents))
      ctx.addIssue({ code: 'custom', message: 'Agent and human handles must be unique.' });
  });
export type BoardConfig = z.infer<typeof configSchema>;
