import { useI18n } from './i18n.js';
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
import { TaskPicker, TaskReference } from './TaskPicker.js';
import { TaskRuns } from './TaskRuns.js';
import { InlineTaskText } from './InlineTaskText.js';
import { actionNames, boardColumns, dropTargets } from './task-ui.js';
const taskTabs = [
  ['content', '任务内容'],
  ['runs', '执行与证据'],
  ['discussion', '讨论记录'],
] as const;

export function NewTask({ onClose, parentTask }: { onClose: () => void; parentTask?: Task }) {
  const tr = useI18n();
  const [repository, setRepository] = useState(parentTask?.repository ?? '');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('implement');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [context, setContext] = useState(
    typeof parentTask?.context.handoff === 'string' ? parentTask.context.handoff : '',
  );
  const [priority, setPriority] = useState('P2');
  const [role, setRole] = useState('implementer');
  const [parent, setParent] = useState<number[]>(parentTask ? [parentTask.id] : []);
  const [deps, setDeps] = useState<number[]>([]);
  const [draft, setDraft] = useState(true);
  const [detailed, setDetailed] = useState(false);
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
        parent_id: parent[0],
        repository: repository.trim() || undefined,
        depends_on: deps,
        acceptance_criteria: criteria
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        context: context ? { handoff: context } : {},
        writes_code: writes || ['implement', 'bug', 'merge'].includes(type),
        draft: !detailed || draft,
      });
      const result = await action.mutateAsync({ operation: 'create_task', input });
      onClose();
      openTask((result.data as Task).id);
    } catch (error) {
      setError(error);
    }
  };
  return (
    <Dialog title={tr('创建任务')} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {['plan', 'merge'].includes(type) && (
          <p className="muted small">
            {tr(
              '计划与合入任务先保存为草稿。计划批准后推进子任务；合入是否额外审批由项目设置决定。',
            )}
          </p>
        )}
        <label>
          {tr('任务名称')}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('一个清晰、可以验收的工作单元')}
            required
            maxLength={240}
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            {tr('类型')}
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
                  {tr(typeNames[t])}
                </option>
              ))}
            </select>
          </label>
          {detailed && (
            <>
              <label>
                {tr('优先级')}
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  {['P0', 'P1', 'P2', 'P3'].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                {tr('建议角色')}
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder={tr('不限')}
                />
              </label>
            </>
          )}
        </div>
        {parentTask && (
          <p className="muted small">
            {tr('子任务属于 T-{0}，已继承仓库和交接上下文。', parentTask.id)}
          </p>
        )}
        <button
          type="button"
          className="text-button"
          aria-expanded={detailed}
          onClick={() => setDetailed(!detailed)}
        >
          {detailed ? tr('收起任务信息') : tr('补充任务信息')}
        </button>
        {!detailed && (
          <p className="muted small">{tr('先保存草稿，准备执行时再补充范围与验收标准。')}</p>
        )}
        {detailed && (
          <>
            <label>
              {tr('仓库路径')}
              <span className="label-hint">{tr('可稍后选择；代码任务开工前必须确定')}</span>
              <input
                value={repository}
                onChange={(e) => setRepository(e.target.value)}
                list="task-repositories"
                placeholder={tr('服务所在机器上的 Git 仓库绝对路径')}
              />
              <datalist id="task-repositories">
                {repositories.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
            <label>
              {tr('描述')}
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder={tr('目标、范围，以及为什么要做这件事…')}
              />
            </label>
            <label>
              {tr('验收标准')}
              <span className="label-hint">{tr('每行一条')}</span>
              <textarea
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                rows={3}
                placeholder={tr('完成后如何确认结果正确？')}
              />
            </label>
            <label>
              {tr('交接上下文')}
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={2}
                placeholder={tr('相关文件、约束和明确不做的事')}
              />
            </label>
            <TaskPicker
              label={tr('父计划')}
              value={parent}
              onChange={setParent}
              single
              plansOnly
              disabled={Boolean(parentTask)}
            />
            <TaskPicker label={tr('依赖任务')} value={deps} onChange={setDeps} exclude={parent} />
            <div className="form-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                />
                {tr('保存为草稿')}
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={writes || ['implement', 'bug', 'merge'].includes(type)}
                  disabled={['implement', 'bug', 'merge'].includes(type)}
                  onChange={(e) => setWrites(e.target.checked)}
                />
                {tr('需要修改代码')}
              </label>
            </div>
          </>
        )}
        <ErrorNotice error={error} />
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="button primary" disabled={action.isPending}>
            <Plus size={16} />
            {action.isPending
              ? tr('创建中…')
              : !detailed || draft
                ? tr('保存草稿')
                : tr('创建任务')}
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
  siblings,
}: {
  task: TaskSummary;
  draggable?: boolean;
  grouped?: boolean;
  siblings?: number[];
}) {
  const tr = useI18n();
  const { openTask, me } = useBoard();
  const action = useAction();
  const drag = useDraggable({
    id: task.id,
    disabled: !draggable || transitions[task.status].length === 0,
  });
  return (
    <article
      ref={drag.setNodeRef}
      className={`task-card ${drag.isDragging ? 'dragging' : ''}`}
      data-priority={task.priority}
      data-frozen={task.frozen || undefined}
      style={
        drag.transform
          ? { transform: `translate3d(${drag.transform.x}px,${drag.transform.y}px,0)`, zIndex: 10 }
          : undefined
      }
    >
      <div className="task-card-top">
        <span className="mono">T-{task.id}</span>
        {me.kind === 'human' && !['done', 'cancelled'].includes(task.status) ? (
          <select
            className={`card-priority priority-${task.priority}`}
            aria-label={tr('T-{0} 优先级', task.id)}
            value={task.priority}
            disabled={action.isPending}
            onChange={(event) =>
              action.mutate({
                operation: 'update_task',
                input: { id: task.id, priority: event.target.value as 'P2' },
              })
            }
          >
            {['P0', 'P1', 'P2', 'P3'].map((priority) => (
              <option key={priority}>{priority}</option>
            ))}
          </select>
        ) : (
          <span className={`priority priority-${task.priority}`}>{task.priority}</span>
        )}
        {draggable && transitions[task.status].length > 0 && (
          <button
            className="drag-handle"
            aria-label={tr('拖动 T-{0}', task.id)}
            {...drag.listeners}
            {...drag.attributes}
          >
            <GripVertical size={15} />
          </button>
        )}
      </div>
      {grouped && task.parent_id && (
        <button className="parent-link" onClick={() => openTask(task.parent_id!)}>
          {tr('↳ 父任务 T-{0}', task.parent_id)}
        </button>
      )}
      <button className="task-title" onClick={() => openTask(task.id, siblings)}>
        {task.title}
      </button>
      {task.repository && (
        <div className="task-repository muted small" title={task.repository}>
          {task.repository}
        </div>
      )}
      <ErrorNotice error={action.error} />
      <div className="task-card-tags">
        <Badge status={task.status} />
        <span className="tag">{tr(typeNames[task.type])}</span>
        {task.writes_code && (
          <span title={tr('需要写入锁')}>
            <LockKeyhole size={12} />
          </span>
        )}
        {task.frozen && <Snowflake size={13} aria-label={tr('已冻结')} />}
        {task.attempt > 0 && <span className="attempt">{tr('返工 {0}', task.attempt)}</span>}
      </div>
      <div className="task-card-bottom">
        {task.assignee ? (
          <span className="inline">
            <Avatar handle={task.assignee} size="small" />
            {task.assignee}
          </span>
        ) : (
          <span className="muted">
            {tr('等待{0}', task.role_hint ? ` ${task.role_hint}` : tr('认领'))}
          </span>
        )}
        <span className="muted small">{time(task.updated_at)}</span>
      </div>
    </article>
  );
}
function Column({
  column,
  children,
  count,
  allowed,
}: {
  column: (typeof boardColumns)[number];
  children: ReactNode;
  count: number;
  allowed: boolean;
}) {
  const tr = useI18n();
  const drop = useDroppable({ id: column.id, disabled: !allowed });
  return (
    <section
      ref={drop.setNodeRef}
      className={`kanban-column stage-column ${drop.isOver ? 'drag-over' : ''}`}
      data-status={column.statuses[0]}
      data-drop-disabled={!allowed || undefined}
      aria-label={tr('{0} · {1} 项', tr(column.label), count)}
    >
      <div className="column-title">
        <strong>{tr(column.label)}</strong>
        <span className="column-count">{count}</span>
      </div>
      <div className="column-cards">{children}</div>
    </section>
  );
}
export function TaskBoard() {
  const tr = useI18n();
  const { me, participants, openTask, repositories } = useBoard();
  const [repository, setRepository] = useState('');
  const [assignee, setAssignee] = useState('');
  const [parent, setParent] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(0);
  const [archive, setArchive] = useState(false);
  const [dragging, setDragging] = useState<TaskSummary>();
  const [move, setMove] = useState<{ task: TaskSummary; targets: TaskStatus[] }>();
  const [moveStatus, setMoveStatus] = useState<TaskStatus>();
  const [moveReason, setMoveReason] = useState('');
  const [moveCommit, setMoveCommit] = useState('');
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
  const columns = boardColumns.filter((column) => archive || column.id !== 'finished');
  const siblings = (tasks.data ?? []).map((task) => task.id);
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-filters">
          <select
            aria-label={tr('筛选仓库')}
            value={repository}
            onChange={(e) => {
              setRepository(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{tr('全部仓库')}</option>
            {repositories.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            aria-label={tr('筛选负责人')}
            value={assignee}
            onChange={(e) => {
              setAssignee(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{tr('全部负责人')}</option>
            {participants.map((p) => (
              <option key={p.handle} value={p.handle}>
                @{p.handle}
              </option>
            ))}
          </select>
          <input
            aria-label={tr('筛选父任务')}
            type="number"
            min={1}
            value={parent}
            onChange={(e) => {
              setParent(e.target.value);
              setPage(0);
            }}
            placeholder={tr('父任务 ID')}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
            />
            {tr('按父任务分组')}
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
            {tr('显示已结束')}
          </label>
        </div>
        <span className="toolbar-hint">{tr('拖动卡片后确认具体状态')}</span>
      </div>
      <ErrorNotice error={tasks.error ?? action.error} />
      {notice && <div className="info-notice">{tr(notice)}</div>}
      <DndContext
        sensors={sensors}
        onDragStart={(event) =>
          setDragging(tasks.data?.find((task) => task.id === Number(event.active.id)))
        }
        onDragCancel={() => setDragging(undefined)}
        onDragEnd={(event) => {
          setDragging(undefined);
          if (!event.over || action.isPending) return;
          const task = tasks.data?.find((item) => item.id === Number(event.active.id));
          if (
            !task ||
            boardColumns
              .find((column) => column.id === event.over!.id)
              ?.statuses.includes(task.status)
          )
            return;
          const targets = dropTargets(task.status, String(event.over.id));
          if (!targets.length) {
            setNotice('当前状态不能移到这一列。');
            return;
          }
          action.reset();
          setNotice('');
          setMove({ task, targets });
          setMoveStatus(targets[0]);
          setMoveReason('');
          setMoveCommit('');
        }}
      >
        <div className="kanban">
          {columns.map((column) => {
            const items = (tasks.data ?? [])
              .filter((t) => column.statuses.includes(t.status))
              .sort((a, b) =>
                grouped
                  ? (a.parent_id ?? a.id) - (b.parent_id ?? b.id) ||
                    a.priority.localeCompare(b.priority) ||
                    a.id - b.id
                  : 0,
              );
            return (
              <Column
                key={column.id}
                column={column}
                count={items.length}
                allowed={!dragging || dropTargets(dragging.status, column.id).length > 0}
              >
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
                            {tasks.data?.find((t) => t.id === parentId)?.title ?? tr('父任务')}
                          </button>
                        ) : (
                          <h3 className="group-heading">{tr('独立任务')}</h3>
                        )}
                        {items
                          .filter((t) => groupFor(t) === parentId)
                          .map((task) => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              draggable={me.kind === 'human'}
                              siblings={siblings}
                            />
                          ))}
                      </section>
                    ))
                  : items.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        draggable={me.kind === 'human'}
                        siblings={siblings}
                      />
                    ))}
                {!items.length && <p className="column-empty">{tr('暂无任务')}</p>}
              </Column>
            );
          })}
        </div>
      </DndContext>
      {move && (
        <Dialog
          title={tr('调整 T-{0} 的状态', move.task.id)}
          onClose={() => {
            setMove(undefined);
            action.reset();
          }}
        >
          <form
            className="form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!moveStatus) return;
              try {
                await action.mutateAsync({
                  operation: 'transition_task',
                  input: {
                    id: move.task.id,
                    status: moveStatus,
                    reason: moveReason,
                    ...(moveStatus === 'in_review' && move.task.writes_code
                      ? { artifacts: [{ kind: 'commit', ref: moveCommit }] }
                      : {}),
                  },
                });
                setMove(undefined);
              } catch {
                /* Keep the requested change and show the validation failure. */
              }
            }}
          >
            <p>{move.task.title}</p>
            <label>
              {tr('目标状态')}
              <select
                value={moveStatus}
                onChange={(event) => setMoveStatus(event.target.value as TaskStatus)}
              >
                {move.targets.map((status) => (
                  <option key={status} value={status}>
                    {tr(statusNames[status])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr('操作说明')}
              <textarea
                value={moveReason}
                onChange={(event) => setMoveReason(event.target.value)}
                required
                autoFocus
              />
            </label>
            {moveStatus === 'in_review' && move.task.writes_code && (
              <label>
                {tr('当前 commit SHA')}
                <input
                  value={moveCommit}
                  onChange={(event) => setMoveCommit(event.target.value)}
                  required
                />
              </label>
            )}
            <ErrorNotice error={action.error} />
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setMove(undefined);
                  action.reset();
                }}
              >
                {tr('取消')}
              </button>
              <button className="button primary" disabled={action.isPending || !moveReason.trim()}>
                {tr('确认调整')}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {((tasks.data?.length ?? 0) === 200 || page > 0) && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            {tr('上一页')}
          </button>
          <span>{tr('第 {0} 页 · 每页 200 个任务', page + 1)}</span>
          <button disabled={(tasks.data?.length ?? 0) < 200} onClick={() => setPage(page + 1)}>
            {tr('下一页')}
          </button>
        </div>
      )}
    </>
  );
}
export function TaskDetails({ id }: { id: number }) {
  const tr = useI18n();
  const task = useData<Task>('get_task', { id });
  const settings = useData<Settings>('get_settings');
  const approvals = useData<Approval[]>('list_approvals');
  const { me, participants, openTask } = useBoard();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [tab, setTab] = useState('content');
  const [dependentPage, setDependentPage] = useState(0);
  const dependents = useData<TaskSummary[]>('list_tasks', {
    depends_on: id,
    limit: 20,
    offset: dependentPage * 20,
  });
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<TaskStatus>();
  const [commit, setCommit] = useState('');
  const t = task.data;
  const parentTask = useData<Task>('get_task', { id: t?.parent_id }, Boolean(t?.parent_id));
  const scopeLocked =
    settings.data?.approval_mode === 'plan' &&
    Boolean(
      t?.plan_approved_at ||
        (t?.parent_id && (!parentTask.data || parentTask.data.plan_approved_at)),
    );
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
          reason: reason.trim() || tr('人工确认：{0}', tr(statusNames[status])),
          artifacts:
            status === 'in_review' && t?.writes_code ? [{ kind: 'commit', ref: commit }] : [],
        },
      },
      { onSuccess: () => setTarget(undefined) },
    );
  return (
    <div className="task-detail">
      <ErrorNotice error={task.error ?? action.error} />
      {t ? (
        <>
          <div className="task-detail-heading">
            <div className="task-detail-topline">
              <div className="inline">
                <Badge status={t.status} />
                <span className={`priority priority-${t.priority}`}>{t.priority}</span>
                <span className="tag">{tr(typeNames[t.type])}</span>
                {t.frozen && <span className="tag danger">{tr('已冻结')}</span>}
                {t.plan_approved_at && (
                  <span className="tag">{tr('计划已批准 · @{0}', t.plan_approved_by)}</span>
                )}
              </div>
              {me.kind === 'human' && transitions[t.status].includes('cancelled') && (
                <button
                  className="button danger"
                  disabled={action.isPending}
                  onClick={() => setCancelling(true)}
                >
                  <Ban size={15} />
                  {tr('取消任务')}
                </button>
              )}
            </div>
            <InlineTaskText
              task={t}
              field="title"
              disabled={me.kind !== 'human' || ['done', 'cancelled'].includes(t.status)}
            />
            <div className="detail-meta">
              <span>{tr('创建者 @{0}', t.creator)}</span>
              <span>{tr('负责人 {0}', t.assignee ? `@${t.assignee}` : tr('待认领'))}</span>
              <span>{t.writes_code ? tr('需要写入锁') : tr('只读任务')}</span>
              <span>{tr('返工 {0} 次', t.attempt)}</span>
            </div>
          </div>
          {t.handoff && (
            <section className="handoff-summary" aria-label={tr('当前结果与下一步')}>
              <p>{t.handoff.summary}</p>
              <div className="handoff-next">
                <strong>{tr(actionNames[t.handoff.next_action.action])}</strong>
                <span>
                  {t.handoff.next_action.actor === 'human'
                    ? tr('人工')
                    : `@${t.handoff.next_action.actor}`}
                </span>
                {!['done', 'cancelled'].includes(t.status) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setTab('content');
                      requestAnimationFrame(() =>
                        document
                          .getElementById('task-human-controls')
                          ?.scrollIntoView({ block: 'start' }),
                      );
                    }}
                  >
                    {tr('查看操作')}
                  </button>
                )}
              </div>
              {t.handoff.blockers.map((blocker) => (
                <p className="danger small" key={blocker.code}>
                  {blocker.reason}
                </p>
              ))}
              {t.handoff.lock && (
                <details>
                  <summary>{tr('仓库占用说明')}</summary>
                  <p>{t.handoff.lock.purpose}</p>
                </details>
              )}
            </section>
          )}
          <div className="task-tabs" role="tablist" aria-label={tr('任务详情分区')}>
            {taskTabs.map(([key, label], index) => (
              <button
                role="tab"
                id={`task-tab-${key}`}
                aria-controls={`task-panel-${key}`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                key={key}
                onClick={() => setTab(key)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % 3
                      : event.key === 'ArrowLeft'
                        ? (index + 2) % 3
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 2
                            : undefined;
                  if (next !== undefined) {
                    event.preventDefault();
                    setTab(taskTabs[next]![0]);
                    document.getElementById(`task-tab-${taskTabs[next]![0]}`)?.focus();
                  }
                }}
              >
                {tr(label)}
              </button>
            ))}
          </div>
          {tab === 'runs' && (
            <div role="tabpanel" id="task-panel-runs" aria-labelledby="task-tab-runs">
              <TaskRuns id={id} />
            </div>
          )}
          {tab === 'content' && (
            <div role="tabpanel" id="task-panel-content" aria-labelledby="task-tab-content">
              <div className="detail-grid">
                <div>
                  <section className="detail-section">
                    <h3>{tr('任务描述')}</h3>
                    <InlineTaskText
                      task={t}
                      field="description"
                      disabled={
                        me.kind !== 'human' ||
                        scopeLocked ||
                        ['done', 'cancelled'].includes(t.status)
                      }
                    />
                  </section>
                  <section className="detail-section">
                    <h3>
                      {tr('验收标准')}{' '}
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
                              action.isPending ||
                              t.status !== 'in_review' ||
                              t.assignee === me.handle
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
                      <p className="muted">{tr('未设置验收标准')}</p>
                    )}
                  </section>
                  {Object.keys(t.context).length > 0 && (
                    <section className="detail-section">
                      <h3>{tr('交接上下文')}</h3>
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
                      {tr('产物')}
                      <span className="muted">{t.artifacts.length}</span>
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
                      <p className="muted">{tr('提交后，commit、报告和链接会显示在这里。')}</p>
                    )}
                  </section>
                </div>
                <aside>
                  <section className="detail-section">
                    <h3>{tr('目标仓库')}</h3>
                    <p className="repository-path">
                      {t.repository ??
                        (t.writes_code
                          ? tr('尚未选择，开工前请编辑任务补充。')
                          : tr('未指定，可用于跨仓库规划。'))}
                    </p>
                  </section>
                  <section className="detail-section">
                    <h3>{tr('关联任务')}</h3>
                    {t.type === 'plan' &&
                      !t.plan_approved_at &&
                      !['done', 'cancelled'].includes(t.status) && (
                        <button className="text-button" onClick={() => setCreatingChild(true)}>
                          <Plus size={14} />
                          {tr('添加子任务')}
                        </button>
                      )}
                    {t.workflow_plan && (
                      <>
                        <p className="muted small">
                          {tr('批准计划后，可按依赖派发以下任务。新增范围需另建计划。')}
                        </p>
                        <ErrorNotice error={children.error} />
                        <div className="dependency-list">
                          {children.data?.map((child) => (
                            <button
                              className="text-button"
                              key={child.id}
                              onClick={() => openTask(child.id)}
                            >
                              T-{child.id} · {child.title} · {tr(statusNames[child.status])}
                            </button>
                          ))}
                        </div>
                        {(childPage > 0 || children.data?.length === 200) && (
                          <div className="pagination">
                            <button
                              disabled={childPage === 0}
                              onClick={() => setChildPage(childPage - 1)}
                            >
                              {tr('上一页')}
                            </button>
                            <button
                              disabled={children.data?.length !== 200}
                              onClick={() => setChildPage(childPage + 1)}
                            >
                              {tr('下一页')}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    {t.parent_id && <TaskReference id={t.parent_id} />}
                    <h4>{tr('依赖这些任务')}</h4>
                    {t.depends_on.map((dep) => (
                      <TaskReference key={dep} id={dep} />
                    ))}
                    {!t.depends_on.length && <p className="muted small">{tr('无依赖')}</p>}
                    <h4>{tr('这些任务依赖此任务')}</h4>
                    <ErrorNotice error={dependents.error} />
                    {dependents.data?.map((dependent) => (
                      <TaskReference key={dependent.id} id={dependent.id} />
                    ))}
                    {dependents.data?.length === 0 && (
                      <p className="muted small">{tr('暂无后续依赖')}</p>
                    )}
                    {(dependentPage > 0 || dependents.data?.length === 20) && (
                      <div className="pagination">
                        <button
                          disabled={dependentPage === 0}
                          onClick={() => setDependentPage(dependentPage - 1)}
                        >
                          {tr('上一页')}
                        </button>
                        <button
                          disabled={dependents.data?.length !== 20}
                          onClick={() => setDependentPage(dependentPage + 1)}
                        >
                          {tr('下一页')}
                        </button>
                      </div>
                    )}
                  </section>
                  {t.lease_until && (
                    <section className="detail-section">
                      <h3>{tr('认领租约')}</h3>
                      <p className={t.lease_expired_at ? 'danger' : 'muted'}>
                        {t.lease_expired_at
                          ? tr('已过期，写入锁仍保留')
                          : tr('到期 {0}', time(t.lease_until))}
                      </p>
                    </section>
                  )}
                  {t.labels.length > 0 && (
                    <section className="detail-section">
                      <h3>{tr('标签')}</h3>
                      {t.labels.map((label) => (
                        <span className="tag" key={label}>
                          {label}
                        </span>
                      ))}
                    </section>
                  )}
                  {me.kind === 'human' && (
                    <section className="human-controls" id="task-human-controls">
                      <h3>{tr('人工操作')}</h3>
                      {approvals.data
                        ?.filter((a) => a.task_id === id)
                        .map((a) => (
                          <div className="approval-inline" key={a.id}>
                            <strong>{tr('申请：{0}', tr(statusNames[a.to_status]))}</strong>
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
                                ? tr('批准计划')
                                : t.type === 'merge' && a.to_status === 'open'
                                  ? tr('批准合入')
                                  : tr('批准')}
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
                              {tr('驳回')}
                            </button>
                          </div>
                        ))}
                      {['done', 'cancelled'].includes(t.status) && (
                        <p className="muted small">{tr('任务已结束，历史记录会完整保留。')}</p>
                      )}
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
                                {tr('批准计划')}
                              </button>
                            )}
                          <label>
                            {tr('操作说明')}
                            <textarea
                              aria-label={tr('人工操作说明')}
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              rows={3}
                              placeholder={tr('说明审批、驳回或调整的原因')}
                            />
                          </label>
                          {!t.workflow_plan && (
                            <>
                              <label>
                                {tr('调整状态')}
                                <select
                                  aria-label={tr('调整任务状态')}
                                  value={target ?? ''}
                                  onChange={(e) => setTarget(e.target.value as TaskStatus)}
                                >
                                  <option value="">{tr('选择下一状态')}</option>
                                  {transitions[t.status]
                                    .filter((s) => s !== 'cancelled')
                                    .map((s) => (
                                      <option key={s} value={s}>
                                        {tr(statusNames[s])}
                                        {settings.data &&
                                        isGated(settings.data, t.status, s, t.type)
                                          ? tr(' · 人工审批')
                                          : ''}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              {target === 'in_review' && t.writes_code && (
                                <label>
                                  {tr('当前 commit SHA')}
                                  <input
                                    aria-label={tr('当前 commit SHA')}
                                    value={commit}
                                    onChange={(e) => setCommit(e.target.value)}
                                    placeholder={tr('完整 commit SHA')}
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
                                {tr('确认调整')}
                              </button>
                              <label>
                                {tr('负责人')}
                                <select
                                  aria-label={tr('改派负责人')}
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
                                  <option value="">{tr('待认领')}</option>
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
                            {tr('优先级')}
                            <select
                              aria-label={tr('修改优先级')}
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
                            {t.frozen ? tr('恢复任务') : tr('冻结任务')}
                          </button>
                          {t.plan_approved_at && (
                            <p className="muted small">
                              {tr('计划范围已批准。新增或变更范围请创建后续计划。')}
                            </p>
                          )}
                          <button
                            className="text-button"
                            disabled={scopeLocked}
                            onClick={() => setEditing(true)}
                          >
                            {tr('编辑任务与依赖')}
                          </button>
                        </>
                      )}
                    </section>
                  )}
                </aside>
              </div>
            </div>
          )}
          {tab === 'discussion' && (
            <section
              className="detail-section"
              role="tabpanel"
              id="task-panel-discussion"
              aria-labelledby="task-tab-discussion"
            >
              <h3>{tr('讨论记录')}</h3>
              <Composer destination={{ task_id: id }} />
              <EventList taskId={id} />
            </section>
          )}
          {creatingChild && <NewTask parentTask={t} onClose={() => setCreatingChild(false)} />}
          {editing && <EditTask task={t} onClose={() => setEditing(false)} />}
          {cancelling && <CancelTask task={t} onClose={() => setCancelling(false)} />}
        </>
      ) : (
        !task.error && <Empty title={tr('正在读取任务…')} />
      )}
    </div>
  );
}

function CancelTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const tr = useI18n();
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
    <Dialog title={tr('取消任务 T-{0}', task.id)} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p>
          {tr('取消「{0}」后会保留历史记录，任务不能重新开启。相关任务不会一并取消。', task.title)}
        </p>
        {task.assignee && (
          <p className="muted">
            {tr(
              '请先确认 @{0} 已停止执行。{1}',
              task.assignee,
              task.writes_code && tr('取消会释放该任务持有的写入锁，不会修改仓库文件。'),
            )}
          </p>
        )}
        <ErrorNotice error={action.error} />
        {!canCancel && <p className="muted">{tr('任务已经结束，无需再次取消。')}</p>}
        <label>
          {tr('取消原因')}
          <textarea
            aria-label={tr('取消原因')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={tr('例如：原计划已调整，取消后重新创建任务')}
            rows={3}
            maxLength={20000}
            disabled={action.isPending || !canCancel}
            required
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button className="button" type="button" onClick={onClose}>
            {tr('返回')}
          </button>
          <button
            className="button danger"
            type="submit"
            disabled={action.isPending || !canCancel || !reason.trim()}
          >
            {action.isPending ? tr('正在取消…') : tr('确认取消任务')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function EditTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const tr = useI18n();
  const { repositories } = useBoard();
  const [repository, setRepository] = useState(task.repository ?? '');
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(task.acceptance_criteria.map((c) => c.text).join('\n'));
  const [dependencies, setDependencies] = useState(task.depends_on);
  const action = useAction();
  return (
    <Dialog title={tr('编辑任务')} onClose={onClose}>
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
                ...(JSON.stringify(dependencies) !== JSON.stringify(task.depends_on)
                  ? { depends_on: dependencies }
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
          {tr('名称')}
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          {tr('描述')}
          <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          {tr('仓库路径')}
          <span className="label-hint">{tr('开工后不可切换仓库')}</span>
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
          {tr('验收标准')}
          <span className="label-hint">{tr('修改标准会重置勾选状态')}</span>
          <textarea rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <TaskPicker
          label={tr('依赖任务')}
          value={dependencies}
          onChange={setDependencies}
          exclude={[task.id]}
        />
        <ErrorNotice error={action.error} />
        <button className="button primary" disabled={action.isPending}>
          {tr('保存')}
        </button>
      </form>
    </Dialog>
  );
}
