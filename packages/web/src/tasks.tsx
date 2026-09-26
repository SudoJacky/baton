import { useState, type FormEvent, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  CheckCircle2,
  GitCommitHorizontal,
  GripVertical,
  LockKeyhole,
  Plus,
  Snowflake,
  ArrowUpRight,
  Ban,
} from 'lucide-react';
import {
  statuses,
  transitions,
  taskTypes,
  isGated,
  schemas,
  type Approval,
  type Settings,
  type Task,
  type TaskStatus,
  type TaskSummary,
} from '@baton/shared';
import {
  Avatar,
  Badge,
  Dialog,
  Empty,
  ErrorNotice,
  EventList,
  statusNames,
  time,
  typeNames,
  useAction,
  useBoard,
  useData,
} from './board.js';
import { Composer } from './messages.js';
import { Markdown } from './Markdown.js';

export function NewTask({ onClose }: { onClose: () => void }) {
  const [repository, setRepository] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('implement');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [context, setContext] = useState('');
  const [priority, setPriority] = useState('P2');
  const [role, setRole] = useState('implementer');
  const [parent, setParent] = useState('');
  const [deps, setDeps] = useState('');
  const [draft, setDraft] = useState(false);
  const [writes, setWrites] = useState(false);
  const [error, setError] = useState<unknown>();
  const action = useAction();
  const { openTask, repositories } = useBoard();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const input = schemas.create_task.parse({
        title,
        type,
        description,
        priority,
        role_hint: role || undefined,
        parent_id: parent ? Number(parent) : undefined,
        repository: repository.trim() || undefined,
        depends_on: deps
          ? deps
              .split(/[，,\s]+/)
              .filter(Boolean)
              .map(Number)
          : [],
        acceptance_criteria: criteria
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        context: context ? { handoff: context } : {},
        writes_code: writes || ['implement', 'bug', 'merge'].includes(type),
        draft,
      });
      const result = await action.mutateAsync({ operation: 'create_task', input });
      onClose();
      openTask((result.data as Task).id);
    } catch (error) {
      setError(error);
    }
  };
  return (
    <Dialog title="创建任务" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {['plan', 'merge'].includes(type) && (
          <p className="muted small">
            计划与合入任务先保存为草稿。计划批准后推进子任务；合入是否额外审批由项目设置决定。
          </p>
        )}
        <label>
          任务名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一个清晰、可以验收的工作单元"
            required
            maxLength={240}
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            类型
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setRole(
                  (
                    {
                      plan: 'planner',
                      implement: 'implementer',
                      merge: 'implementer',
                      test: 'tester',
                      review: 'reviewer',
                      bug: 'implementer',
                      question: 'planner',
                    } as Record<string, string>
                  )[e.target.value] ?? '',
                );
              }}
            >
              {taskTypes.map((t) => (
                <option key={t} value={t}>
                  {typeNames[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            优先级
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['P0', 'P1', 'P2', 'P3'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            建议角色
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="不限" />
          </label>
        </div>
        <label>
          仓库路径<span className="label-hint">可稍后选择；代码任务开工前必须确定</span>
          <input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            list="task-repositories"
            placeholder="服务所在机器上的 Git 仓库绝对路径"
          />
          <datalist id="task-repositories">
            {repositories.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label>
          描述
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="目标、范围，以及为什么要做这件事…"
          />
        </label>
        <label>
          验收标准<span className="label-hint">每行一条</span>
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={3}
            placeholder="完成后如何确认结果正确？"
          />
        </label>
        <label>
          交接上下文
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="相关文件、约束和明确不做的事"
          />
        </label>
        <div className="form-row">
          <label>
            父任务
            <input
              type="number"
              min={1}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              placeholder="任务 ID（可选）"
            />
          </label>
          <label>
            依赖任务
            <input
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              placeholder="ID，以逗号分隔"
            />
          </label>
        </div>
        <div className="form-row">
          <label className="checkbox-label">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            保存为草稿
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={writes || ['implement', 'bug'].includes(type)}
              disabled={['implement', 'bug'].includes(type)}
              onChange={(e) => setWrites(e.target.checked)}
            />
            需要修改代码
          </label>
        </div>
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={action.isPending}>
            <Plus size={16} />
            {action.isPending ? '创建中…' : '创建任务'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function TaskCard({
  task,
  draggable = false,
  grouped = false,
}: {
  task: TaskSummary;
  draggable?: boolean;
  grouped?: boolean;
}) {
  const { openTask } = useBoard();
  const drag = useDraggable({
    id: task.id,
    disabled: !draggable || transitions[task.status].length === 0,
  });
  return (
    <article
      ref={drag.setNodeRef}
      className={`task-card ${drag.isDragging ? 'dragging' : ''}`}
      style={
        drag.transform
          ? { transform: `translate3d(${drag.transform.x}px,${drag.transform.y}px,0)`, zIndex: 10 }
          : undefined
      }
    >
      <div className="task-card-top">
        <span className="mono">T-{task.id}</span>
        <span className={`priority priority-${task.priority}`}>{task.priority}</span>
        {draggable && transitions[task.status].length > 0 && (
          <button
            className="drag-handle"
            aria-label={`拖动 T-${task.id}`}
            {...drag.listeners}
            {...drag.attributes}
          >
            <GripVertical size={15} />
          </button>
        )}
      </div>
      {grouped && task.parent_id && (
        <button className="parent-link" onClick={() => openTask(task.parent_id!)}>
          ↳ 父任务 T-{task.parent_id}
        </button>
      )}
      <button className="task-title" onClick={() => openTask(task.id)}>
        {task.title}
      </button>
      {task.repository && (
        <div className="task-repository muted small" title={task.repository}>
          {task.repository}
        </div>
      )}
      <div className="task-card-tags">
        <span className="tag">{typeNames[task.type]}</span>
        {task.writes_code && (
          <span title="需要写入锁">
            <LockKeyhole size={12} />
          </span>
        )}
        {task.frozen && <Snowflake size={13} aria-label="已冻结" />}
        {task.attempt > 0 && <span className="attempt">返工 {task.attempt}</span>}
      </div>
      <div className="task-card-bottom">
        {task.assignee ? (
          <span className="inline">
            <Avatar handle={task.assignee} size="small" />
            {task.assignee}
          </span>
        ) : (
          <span className="muted">等待{task.role_hint ? ` ${task.role_hint}` : '认领'}</span>
        )}
        <span className="muted small">{time(task.updated_at)}</span>
      </div>
    </article>
  );
}
function Column({
  status,
  children,
  count,
}: {
  status: TaskStatus;
  children: ReactNode;
  count: number;
}) {
  const drop = useDroppable({ id: status });
  return (
    <section ref={drop.setNodeRef} className={`kanban-column ${drop.isOver ? 'drag-over' : ''}`}>
      <div className="column-title">
        <Badge status={status} />
        <span>{count}</span>
      </div>
      <div className="column-cards">{children}</div>
    </section>
  );
}
export function TaskBoard() {
  const { me, participants, openTask, repositories } = useBoard();
  const [repository, setRepository] = useState('');
  const [assignee, setAssignee] = useState('');
  const [parent, setParent] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(0);
  const [archive, setArchive] = useState(false);
  const tasks = useData<TaskSummary[]>('list_tasks', {
    repository: repository || undefined,
    assignee: assignee || undefined,
    parent: parent ? Number(parent) : undefined,
    limit: 200,
    offset: page * 200,
    active_only: !archive,
  });
  const parents = new Set((tasks.data ?? []).map((t) => t.parent_id));
  const groupFor = (task: TaskSummary) => task.parent_id ?? (parents.has(task.id) ? task.id : null);
  const action = useAction();
  const [notice, setNotice] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const columns = statuses.filter((s) => archive || !['done', 'cancelled'].includes(s));
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-filters">
          <select
            aria-label="筛选仓库"
            value={repository}
            onChange={(e) => {
              setRepository(e.target.value);
              setPage(0);
            }}
          >
            <option value="">全部仓库</option>
            {repositories.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选负责人"
            value={assignee}
            onChange={(e) => {
              setAssignee(e.target.value);
              setPage(0);
            }}
          >
            <option value="">全部负责人</option>
            {participants.map((p) => (
              <option key={p.handle} value={p.handle}>
                @{p.handle}
              </option>
            ))}
          </select>
          <input
            aria-label="筛选父任务"
            type="number"
            min={1}
            value={parent}
            onChange={(e) => {
              setParent(e.target.value);
              setPage(0);
            }}
            placeholder="父任务 ID"
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
            />
            按父任务分组
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={archive}
              onChange={(e) => {
                setArchive(e.target.checked);
                setPage(0);
              }}
            />
            显示已结束
          </label>
        </div>
        <span className="muted small">拖动卡片调整状态</span>
      </div>
      <ErrorNotice error={tasks.error ?? action.error} />
      {notice && <div className="info-notice">{notice}</div>}
      <DndContext
        sensors={sensors}
        onDragEnd={(event) => {
          if (!event.over || action.isPending) return;
          const task = tasks.data?.find((t) => t.id === Number(event.active.id));
          const status = String(event.over.id) as TaskStatus;
          if (!task || task.status === status) return;
          if (status === 'in_review' && task.writes_code) {
            setNotice('代码任务提交前需要指定 commit，请在任务详情中提交。');
            openTask(task.id);
            return;
          }
          setNotice('');
          action.mutate({
            operation: 'transition_task',
            input: { id: task.id, status, reason: '通过看板调整任务状态' },
          });
        }}
      >
        <div className="kanban">
          {columns.map((status) => {
            const items = (tasks.data ?? [])
              .filter((t) => t.status === status)
              .sort((a, b) =>
                grouped
                  ? (a.parent_id ?? a.id) - (b.parent_id ?? b.id) ||
                    a.priority.localeCompare(b.priority) ||
                    a.id - b.id
                  : 0,
              );
            return (
              <Column key={status} status={status} count={items.length}>
                {grouped
                  ? [...new Set(items.map(groupFor))].map((parentId) => (
                      <section
                        className="parent-task-group"
                        key={parentId ?? 'independent'}
                        data-parent-id={parentId ?? 'independent'}
                      >
                        {parentId ? (
                          <button className="group-heading" onClick={() => openTask(parentId)}>
                            T-{parentId} ·{' '}
                            {tasks.data?.find((t) => t.id === parentId)?.title ?? '父任务'}
                          </button>
                        ) : (
                          <h3 className="group-heading">独立任务</h3>
                        )}
                        {items
                          .filter((t) => groupFor(t) === parentId)
                          .map((task) => (
                            <TaskCard key={task.id} task={task} draggable={me.kind === 'human'} />
                          ))}
                      </section>
                    ))
                  : items.map((task) => (
                      <TaskCard key={task.id} task={task} draggable={me.kind === 'human'} />
                    ))}
                {!items.length && <p className="column-empty">暂无任务</p>}
              </Column>
            );
          })}
        </div>
      </DndContext>
      {((tasks.data?.length ?? 0) === 200 || page > 0) && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>第 {page + 1} 页 · 每页 200 个任务</span>
          <button disabled={(tasks.data?.length ?? 0) < 200} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
    </>
  );
}
export function TaskDetails({ id, onClose }: { id: number; onClose: () => void }) {
  const task = useData<Task>('get_task', { id });
  const settings = useData<Settings>('get_settings');
  const approvals = useData<Approval[]>('list_approvals');
  const { me, participants, openTask } = useBoard();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<TaskStatus>();
  const [commit, setCommit] = useState('');
  const t = task.data;
  const [childPage, setChildPage] = useState(0);
  const children = useData<TaskSummary[]>(
    'list_tasks',
    { parent: id, limit: 200, offset: childPage * 200 },
    t?.type === 'plan',
  );
  const perform = (status: TaskStatus) =>
    action.mutate(
      {
        operation: 'transition_task',
        input: {
          id,
          status,
          reason: reason.trim() || `人工确认：${statusNames[status]}`,
          artifacts:
            status === 'in_review' && t?.writes_code ? [{ kind: 'commit', ref: commit }] : [],
        },
      },
      { onSuccess: () => setTarget(undefined) },
    );
  return (
    <Dialog title={`T-${id} · 任务详情`} onClose={onClose} wide>
      <ErrorNotice error={task.error ?? action.error} />
      {t ? (
        <>
          <div className="task-detail-heading">
            <div className="task-detail-topline">
              <div className="inline">
                <Badge status={t.status} />
                <span className={`priority priority-${t.priority}`}>{t.priority}</span>
                <span className="tag">{typeNames[t.type]}</span>
                {t.frozen && <span className="tag danger">已冻结</span>}
                {t.plan_approved_at && (
                  <span className="tag">计划已批准 · @{t.plan_approved_by}</span>
                )}
              </div>
              {me.kind === 'human' && transitions[t.status].includes('cancelled') && (
                <button
                  className="button danger"
                  disabled={action.isPending}
                  onClick={() => setCancelling(true)}
                >
                  <Ban size={15} />
                  取消任务
                </button>
              )}
            </div>
            <h1>{t.title}</h1>
            <div className="detail-meta">
              <span>创建者 @{t.creator}</span>
              <span>负责人 {t.assignee ? `@${t.assignee}` : '待认领'}</span>
              <span>{t.writes_code ? '需要写入锁' : '只读任务'}</span>
              <span>返工 {t.attempt} 次</span>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <section className="detail-section">
                <h3>任务描述</h3>
                <Markdown>{t.description || '暂无描述'}</Markdown>
              </section>
              <section className="detail-section">
                <h3>
                  验收标准{' '}
                  <span className="muted">
                    {t.acceptance_criteria.filter((c) => c.checked).length}/
                    {t.acceptance_criteria.length}
                  </span>
                </h3>
                {t.acceptance_criteria.length ? (
                  t.acceptance_criteria.map((c) => (
                    <label className="criterion" key={c.id}>
                      <input
                        type="checkbox"
                        checked={c.checked}
                        disabled={
                          action.isPending || t.status !== 'in_review' || t.assignee === me.handle
                        }
                        onChange={(e) =>
                          action.mutate({
                            operation: 'update_task',
                            input: {
                              id,
                              criteria_check: [{ id: c.id, checked: e.target.checked }],
                            },
                          })
                        }
                      />
                      <span>{c.text}</span>
                      {c.checked && <CheckCircle2 size={14} />}
                    </label>
                  ))
                ) : (
                  <p className="muted">未设置验收标准</p>
                )}
              </section>
              {Object.keys(t.context).length > 0 && (
                <section className="detail-section">
                  <h3>交接上下文</h3>
                  {Object.entries(t.context).map(([key, value]) => (
                    <div key={key}>
                      <span className="muted small">{key}</span>
                      <p className="message-body">
                        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                      </p>
                    </div>
                  ))}
                </section>
              )}
              <section className="detail-section">
                <h3>
                  产物 <span className="muted">{t.artifacts.length}</span>
                </h3>
                {t.artifacts.length ? (
                  t.artifacts.map((a) => (
                    <div className="artifact" key={a.id}>
                      <GitCommitHorizontal size={16} />
                      <span className="tag">{a.kind}</span>
                      {['pr', 'url'].includes(a.kind) && /^https?:\/\//i.test(a.ref) ? (
                        <a href={a.ref} target="_blank" rel="noreferrer">
                          {a.label ?? a.ref}
                          <ArrowUpRight size={12} />
                        </a>
                      ) : (
                        <code>{a.ref}</code>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="muted">提交后，commit、报告和链接会显示在这里。</p>
                )}
              </section>
            </div>
            <aside>
              <section className="detail-section">
                <h3>目标仓库</h3>
                <p className="repository-path">
                  {t.repository ??
                    (t.writes_code
                      ? '尚未选择，开工前请编辑任务补充。'
                      : '未指定，可用于跨仓库规划。')}
                </p>
              </section>
              <section className="detail-section">
                <h3>关联任务</h3>
                {t.workflow_plan && (
                  <>
                    <p className="muted small">
                      批准计划后，以下任务可按依赖自动推进。新增范围需另建计划。
                    </p>
                    <ErrorNotice error={children.error} />
                    <div className="dependency-list">
                      {children.data?.map((child) => (
                        <button
                          className="text-button"
                          key={child.id}
                          onClick={() => openTask(child.id)}
                        >
                          T-{child.id} · {child.title} · {statusNames[child.status]}
                        </button>
                      ))}
                    </div>
                    {(childPage > 0 || children.data?.length === 200) && (
                      <div className="pagination">
                        <button
                          disabled={childPage === 0}
                          onClick={() => setChildPage(childPage - 1)}
                        >
                          上一页
                        </button>
                        <button
                          disabled={children.data?.length !== 200}
                          onClick={() => setChildPage(childPage + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    )}
                  </>
                )}
                {t.parent_id && (
                  <button className="text-button" onClick={() => openTask(t.parent_id!)}>
                    父任务 T-{t.parent_id}
                  </button>
                )}
                <div className="dependency-list">
                  {t.depends_on.map((dep) => (
                    <button className="tag" key={dep} onClick={() => openTask(dep)}>
                      依赖 T-{dep}
                    </button>
                  ))}
                </div>
                {!t.parent_id && !t.depends_on.length && <p className="muted">无依赖</p>}
              </section>
              {t.lease_until && (
                <section className="detail-section">
                  <h3>认领租约</h3>
                  <p className={t.lease_expired_at ? 'danger' : 'muted'}>
                    {t.lease_expired_at ? '已过期，写入锁仍保留' : `到期 ${time(t.lease_until)}`}
                  </p>
                </section>
              )}
              {t.labels.length > 0 && (
                <section className="detail-section">
                  <h3>标签</h3>
                  {t.labels.map((label) => (
                    <span className="tag" key={label}>
                      {label}
                    </span>
                  ))}
                </section>
              )}
              {me.kind === 'human' && (
                <section className="human-controls">
                  <h3>人工操作</h3>
                  {approvals.data
                    ?.filter((a) => a.task_id === id)
                    .map((a) => (
                      <div className="approval-inline" key={a.id}>
                        <strong>申请：{statusNames[a.to_status]}</strong>
                        <p>{a.reason}</p>
                        <button
                          className="button primary"
                          disabled={action.isPending}
                          onClick={() => {
                            setTarget(a.to_status);
                            if (a.to_status !== 'in_review') perform(a.to_status);
                          }}
                        >
                          {t.type === 'plan' && a.to_status === 'open'
                            ? '批准计划'
                            : t.type === 'merge' && a.to_status === 'open'
                              ? '批准合入'
                              : '批准'}
                        </button>
                        <button
                          className="button subtle"
                          disabled={action.isPending || !reason.trim()}
                          onClick={() =>
                            action.mutate({
                              operation: 'reject_approval',
                              input: { id: a.id, reason },
                            })
                          }
                        >
                          驳回
                        </button>
                      </div>
                    ))}
                  {!['done', 'cancelled'].includes(t.status) && (
                    <>
                      {t.workflow_plan &&
                        t.status === 'draft' &&
                        !approvals.data?.some((a) => a.task_id === id) && (
                          <button
                            className="button primary"
                            disabled={action.isPending}
                            onClick={() => perform('open')}
                          >
                            批准计划
                          </button>
                        )}
                      <label>
                        操作说明
                        <textarea
                          aria-label="人工操作说明"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          rows={3}
                          placeholder="说明审批、驳回或调整的原因"
                        />
                      </label>
                      {!t.workflow_plan && (
                        <>
                          <label>
                            调整状态
                            <select
                              aria-label="调整任务状态"
                              value={target ?? ''}
                              onChange={(e) => setTarget(e.target.value as TaskStatus)}
                            >
                              <option value="">选择下一状态</option>
                              {transitions[t.status]
                                .filter((s) => s !== 'cancelled')
                                .map((s) => (
                                  <option key={s} value={s}>
                                    {statusNames[s]}
                                    {settings.data && isGated(settings.data, t.status, s, t.type)
                                      ? ' · 人工审批'
                                      : ''}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {target === 'in_review' && t.writes_code && (
                            <label>
                              当前 commit SHA
                              <input
                                aria-label="当前 commit SHA"
                                value={commit}
                                onChange={(e) => setCommit(e.target.value)}
                                placeholder="完整 commit SHA"
                                required
                              />
                            </label>
                          )}
                          <button
                            className="button primary"
                            disabled={action.isPending || !target || !reason.trim()}
                            onClick={() => {
                              if (target) perform(target);
                            }}
                          >
                            确认调整
                          </button>
                          <label>
                            负责人
                            <select
                              aria-label="改派负责人"
                              value={t.assignee ?? ''}
                              disabled={
                                action.isPending || ['draft', 'in_review'].includes(t.status)
                              }
                              onChange={(e) =>
                                action.mutate({
                                  operation: 'update_task',
                                  input: { id, assignee: e.target.value || null },
                                })
                              }
                            >
                              <option value="">待认领</option>
                              {participants.map((p) => (
                                <option key={p.handle} value={p.handle}>
                                  @{p.handle}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                      <label>
                        优先级
                        <select
                          aria-label="修改优先级"
                          value={t.priority}
                          disabled={action.isPending}
                          onChange={(e) =>
                            action.mutate({
                              operation: 'update_task',
                              input: { id, priority: e.target.value as 'P2' },
                            })
                          }
                        >
                          {['P0', 'P1', 'P2', 'P3'].map((p) => (
                            <option key={p}>{p}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="button"
                        disabled={action.isPending}
                        onClick={() =>
                          action.mutate({
                            operation: 'update_task',
                            input: { id, frozen: !t.frozen },
                          })
                        }
                      >
                        <Snowflake size={15} />
                        {t.frozen ? '恢复任务' : '冻结任务'}
                      </button>
                      {t.plan_approved_at && (
                        <p className="muted small">
                          计划范围已批准。新增或变更范围请创建后续计划。
                        </p>
                      )}
                      <button
                        className="text-button"
                        disabled={Boolean(t.plan_approved_at)}
                        onClick={() => setEditing(true)}
                      >
                        编辑任务与依赖
                      </button>
                    </>
                  )}
                </section>
              )}
            </aside>
          </div>
          <section className="detail-section">
            <h3>统一时间线</h3>
            <Composer destination={{ task_id: id }} />
            <EventList taskId={id} />
          </section>
          {editing && <EditTask task={t} onClose={() => setEditing(false)} />}
          {cancelling && <CancelTask task={t} onClose={() => setCancelling(false)} />}
        </>
      ) : (
        !task.error && <Empty title="正在读取任务…" />
      )}
    </Dialog>
  );
}

function CancelTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const action = useAction();
  const canCancel = transitions[task.status].includes('cancelled');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canCancel || !reason.trim() || action.isPending) return;
    action.mutate(
      {
        operation: 'transition_task',
        input: { id: task.id, status: 'cancelled', reason: reason.trim() },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog title={`取消任务 T-${task.id}`} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p>取消「{task.title}」后会保留历史记录，任务不能重新开启。相关任务不会一并取消。</p>
        {task.assignee && (
          <p className="muted">
            请先确认 @{task.assignee} 已停止执行。
            {task.writes_code && '取消会释放该任务持有的写入锁，不会修改仓库文件。'}
          </p>
        )}
        <ErrorNotice error={action.error} />
        {!canCancel && <p className="muted">任务已经结束，无需再次取消。</p>}
        <label>
          取消原因
          <textarea
            aria-label="取消原因"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：原计划已调整，取消后重新创建任务"
            rows={3}
            maxLength={20000}
            disabled={action.isPending || !canCancel}
            required
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button className="button" type="button" onClick={onClose}>
            返回
          </button>
          <button
            className="button danger"
            type="submit"
            disabled={action.isPending || !canCancel || !reason.trim()}
          >
            {action.isPending ? '正在取消…' : '确认取消任务'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function EditTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const { repositories } = useBoard();
  const [repository, setRepository] = useState(task.repository ?? '');
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(task.acceptance_criteria.map((c) => c.text).join('\n'));
  const [dependencies, setDependencies] = useState(task.depends_on.join(', '));
  const action = useAction();
  return (
    <Dialog title="编辑任务" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await action.mutateAsync({
              operation: 'update_task',
              input: {
                id: task.id,
                title,
                description,
                ...(repository !== (task.repository ?? '')
                  ? { repository: repository.trim() || null }
                  : {}),
                ...(dependencies !== task.depends_on.join(', ')
                  ? {
                      depends_on: dependencies
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map(Number),
                    }
                  : {}),
                ...(criteria !== task.acceptance_criteria.map((c) => c.text).join('\n')
                  ? {
                      acceptance_criteria: criteria
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
              },
            });
            onClose();
          } catch {
            /* Render the mutation error. */
          }
        }}
      >
        <label>
          名称
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          描述
          <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          仓库路径<span className="label-hint">开工后不可切换仓库</span>
          <input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            list="edit-repositories"
            disabled={
              task.repository !== null &&
              (['in_progress', 'in_review', 'done', 'cancelled', 'changes_requested'].includes(
                task.status,
              ) ||
                task.artifacts.length > 0)
            }
          />
          <datalist id="edit-repositories">
            {repositories.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <label>
          验收标准<span className="label-hint">修改标准会重置勾选状态</span>
          <textarea rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <label>
          依赖任务
          <span className="label-hint">
            输入任务 ID，以逗号分隔。前置任务取消后，可在这里移除或替换。
          </span>
          <input
            value={dependencies}
            onChange={(e) => setDependencies(e.target.value)}
            disabled={['in_progress', 'in_review'].includes(task.status)}
          />
        </label>
        <ErrorNotice error={action.error} />
        <button className="button primary" disabled={action.isPending}>
          保存
        </button>
      </form>
    </Dialog>
  );
}
