import { useMemo, useState, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BoardClient } from '@baton/client';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  CircleHelp,
  Columns3,
  Inbox as InboxIcon,
  LayoutDashboard,
  LockKeyhole,
  MessageSquare,
  Plus,
  Settings2,
  Users,
  UnlockKeyhole,
  Radio,
  ChevronRight,
  Snowflake,
  ShieldCheck,
} from 'lucide-react';
import type {
  Identity,
  Overview as OverviewData,
  Participant,
  Settings,
  Message,
  TaskSummary,
  WriteLock,
} from '@baton/shared';
import { settingsSchema } from '@baton/shared';
import {
  Avatar,
  Badge,
  BoardContext,
  Dialog,
  Empty,
  ErrorNotice,
  EventList,
  ago,
  errorText,
  statusNames,
  useAction,
  useBoard,
  useData,
  useEvents,
} from './board.js';
import { Inbox, Messages, MessageCard } from './messages.js';
import { NewTask, TaskBoard, TaskDetails } from './tasks.js';

type Page = 'overview' | 'board' | 'inbox' | 'messages' | 'agents' | 'decisions' | 'settings';
const navigation: { id: Page; label: string; icon: typeof Activity; subtitle: string }[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard, subtitle: '每一次交接，都有迹可循。' },
  { id: 'board', label: '任务看板', icon: Columns3, subtitle: '从想法到完成，让工作有序流动。' },
  { id: 'inbox', label: '收件箱', icon: InboxIcon, subtitle: '需要你的判断，或等你的一句回复。' },
  {
    id: 'messages',
    label: '消息',
    icon: MessageSquare,
    subtitle: '共享上下文，讨论问题，记录决定。',
  },
  { id: 'agents', label: '参与者', icon: Users, subtitle: '独立的会话，在同一个方向上协作。' },
  { id: 'decisions', label: '决策日志', icon: BookOpen, subtitle: '保留为什么做出这个选择。' },
  { id: 'settings', label: '项目设置', icon: Settings2, subtitle: '定义协作规则与人工审批边界。' },
];
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
      </span>
      <span>
        baton<span className="brand-period">.</span>
      </span>
    </div>
  );
}
export function App() {
  const api = useMemo(() => new BoardClient(location.origin), []);
  useEffect(() => {
    sessionStorage.removeItem('baton-token');
  }, []);
  const identity = useQuery({
    queryKey: ['board', 'identity'],
    queryFn: async () => (await api.call<Identity>('whoami', {})).data,
  });
  const overview = useQuery({
    queryKey: ['board', 'get_overview', {}],
    queryFn: async () => (await api.call<OverviewData>('get_overview', {})).data,
    refetchInterval: 30000,
  });
  const connection = useEvents(api, overview.data?.event_cursor);
  const [page, setPage] = useState<Page>('overview');
  const [taskId, setTaskId] = useState<number>();
  const [creating, setCreating] = useState(false);
  if (identity.error || identity.data?.participant.kind === 'agent')
    return (
      <div className="centered">
        <ErrorNotice
          error={identity.error ?? new Error('工作空间未返回本地用户，请检查服务配置。')}
        />
        <button className="button" onClick={() => void identity.refetch()}>
          重新连接
        </button>
      </div>
    );
  if (!identity.data)
    return (
      <div className="centered">
        <Brand />
        <p className="muted">正在连接工作空间…</p>
      </div>
    );
  const current = navigation.find((item) => item.id === page)!;
  const me = identity.data.participant;
  return (
    <BoardContext.Provider
      value={{
        api,
        me,
        openTask: setTaskId,
        participants: overview.data?.participants ?? [],
        repositories: overview.data?.repositories ?? [],
      }}
    >
      <div className="app-shell">
        <aside className="sidebar">
          <Brand />
          <div className="workspace-label">
            <span className="workspace-icon">B</span>
            <div>
              <strong>Agent Board</strong>
              <span>本地工作空间</span>
            </div>
            <ChevronRight size={14} />
          </div>
          <div className="nav-label">工作空间</div>
          <nav aria-label="主导航">
            {navigation.map((item) => (
              <button
                key={item.id}
                aria-label={item.label}
                className={page === item.id ? 'active' : ''}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => setPage(item.id)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {item.id === 'inbox' && Boolean(overview.data?.unread) && (
                  <b className="nav-count">{overview.data!.unread}</b>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-note">
              <Radio size={16} />
              <div>
                <strong>本机协作</strong>
                <span>状态集中，工具自由。</span>
              </div>
            </div>
            <div className="profile">
              <Avatar handle={me.handle} />
              <div>
                <strong>{me.display_name ?? me.handle}</strong>
                <span>Human · @{me.handle}</span>
              </div>
            </div>
          </div>
        </aside>
        <main className="main-area">
          <div className="topbar">
            <span>
              工作空间 <ChevronRight size={12} />
              {current.label}
            </span>
            <div className={`connection ${connection}`}>
              <span className="dot" />
              {connection === 'live'
                ? '实时连接'
                : connection === 'retrying'
                  ? '连接中断，正在重连'
                  : connection === 'unauthorized'
                    ? '连接被拒绝，请检查服务配置'
                    : '正在连接'}
            </div>
          </div>
          <div className="page">
            <header className="page-header">
              <div>
                <span className="eyebrow">
                  {page === 'overview' ? 'WORKSPACE OVERVIEW' : 'AGENT BOARD'}
                </span>
                <h1>{current.label}</h1>
                <p>{current.subtitle}</p>
              </div>
              <button className="button primary" onClick={() => setCreating(true)}>
                <Plus size={17} />
                创建任务
              </button>
            </header>
            <ErrorNotice error={overview.error} />
            {overview.data?.locks.map((lock) => (
              <LockBanner key={lock.repository ?? 'legacy'} lock={lock} />
            ))}
            <LockBanner />
            {page === 'overview' && <Overview data={overview.data} go={setPage} />}
            {page === 'board' && <TaskBoard />}
            {page === 'inbox' && <Inbox />}
            {page === 'messages' && <Messages />}
            {page === 'agents' && <Participants />}
            {page === 'decisions' && <Decisions />}
            {page === 'settings' && <ProjectSettings />}
          </div>
        </main>
      </div>
      {creating && <NewTask onClose={() => setCreating(false)} />}
      {taskId !== undefined && (
        <TaskDetails key={taskId} id={taskId} onClose={() => setTaskId(undefined)} />
      )}
    </BoardContext.Provider>
  );
}
function LockBanner({ lock }: { lock?: WriteLock }) {
  const [mode, setMode] = useState<'acquire' | 'release'>();
  const [reason, setReason] = useState('');
  const [repository, setRepository] = useState('');
  const action = useAction();
  const { openTask, repositories } = useBoard();
  return (
    <>
      <div className={`lock-banner ${lock?.holder ? 'held' : ''}`}>
        <span className="lock-symbol">
          {lock?.holder ? <LockKeyhole size={18} /> : <UnlockKeyhole size={18} />}
        </span>
        <div>
          <strong>{lock?.holder ? `@${lock.holder} 正在持有写入权` : '按仓库协调写入'}</strong>
          <span>
            {lock?.holder
              ? `${lock.repository ?? '旧版本写入锁：请检查原工作目录后释放'} · ${ago(lock.acquired_at)}`
              : '同一仓库由一位参与者修改，不同仓库可同时进行。'}
          </span>
        </div>
        {lock?.task_id && (
          <button className="text-button mono" onClick={() => openTask(lock.task_id!)}>
            T-{lock.task_id}
            <ArrowUpRight size={14} />
          </button>
        )}
        <button
          className="button subtle"
          onClick={() => {
            setReason('');
            setMode(lock?.holder ? 'release' : 'acquire');
          }}
        >
          {lock?.holder ? '处理写入锁' : '我来改'}
        </button>
      </div>
      {mode && (
        <Dialog
          title={mode === 'acquire' ? '取得代码写入权' : '释放代码写入权'}
          onClose={() => setMode(undefined)}
        >
          <p className="muted">
            {mode === 'acquire'
              ? '选择要修改的仓库。同一仓库的代码任务将等待你完成，结束修改后请回来释放。'
              : '请先检查并保存当前工作目录的改动。释放后，原持锁任务会被冻结，避免继续写入。'}
          </p>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await action.mutateAsync({
                  operation: mode === 'acquire' ? 'acquire_lock' : 'release_lock',
                  input: { reason, repository: lock ? lock.repository : repository },
                });
                setMode(undefined);
              } catch {
                /* Error below. */
              }
            }}
          >
            {mode === 'acquire' && (
              <label>
                仓库路径
                <input
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  required
                  list="lock-repositories"
                  placeholder="服务所在机器上的 Git 仓库绝对路径"
                />
                <datalist id="lock-repositories">
                  {repositories.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </label>
            )}
            <label>
              说明
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                rows={3}
                autoFocus
              />
            </label>
            <ErrorNotice error={action.error} />
            <button className="button primary" disabled={action.isPending}>
              {mode === 'acquire' ? '取得写入权' : '已检查工作目录，释放写入权'}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
function Overview({ data, go }: { data?: OverviewData; go: (page: Page) => void }) {
  const { openTask, participants } = useBoard();
  const [actor, setActor] = useState('');
  const [activityTask, setActivityTask] = useState('');
  const [activityType, setActivityType] = useState('');
  const [questionPages, setQuestionPages] = useState<(number | undefined)[]>([undefined]);
  const inbox = useData<import('@baton/shared').Mention[]>('check_inbox', {
    kind: 'question',
    order: 'desc',
    limit: 10,
    before: questionPages.at(-1),
  });
  const [reviewPage, setReviewPage] = useState(0);
  const reviewing = useData<TaskSummary[]>('list_tasks', {
    status: 'in_review',
    limit: 20,
    offset: reviewPage * 20,
  });
  const total = Object.values(data?.counts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const agents = participants.filter((p) => p.kind === 'agent');
  const metrics: { label: string; value: number; note: string; icon: ReactNode; page: Page }[] = [
    {
      label: '全部任务',
      value: total,
      note: `${data?.counts.done ?? 0} 项已完成`,
      icon: <Columns3 size={17} />,
      page: 'board',
    },
    {
      label: '正在进行',
      value: data?.counts.in_progress ?? 0,
      note: `${agents.filter((p) => p.status !== 'offline').length} 个 Agent 最近活跃`,
      icon: <Activity size={17} />,
      page: 'agents',
    },
    {
      label: '等待审批',
      value: data?.approvals.length ?? 0,
      note: `${data?.counts.in_review ?? 0} 项等待验收`,
      icon: <ShieldCheck size={17} />,
      page: 'board',
    },
    {
      label: '@ 我的消息',
      value: data?.unread ?? 0,
      note: '需要你关注的上下文',
      icon: <InboxIcon size={17} />,
      page: 'inbox',
    },
  ];
  return (
    <>
      <div className="metrics">
        {metrics.map((m) => (
          <button className="metric" aria-label={m.label} key={m.label} onClick={() => go(m.page)}>
            <span>
              {m.label}
              {m.icon}
            </span>
            <strong>{m.value.toString().padStart(2, '0')}</strong>
            <small>{m.note}</small>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel agents-panel">
          <div className="panel-heading">
            <h2>Agent 状态</h2>
            <span className="count-circle">{agents.length}</span>
          </div>
          {agents.map((p) => (
            <div className="agent-row" key={p.handle}>
              <div className="agent-row-head">
                <Avatar handle={p.handle} />
                <div>
                  <strong>@{p.handle}</strong>
                  <span className="muted small">{p.role}</span>
                </div>
                <span className={`presence ${p.status}`} title={p.status} />
              </div>
              {p.frozen ? (
                <span className="tag danger">已暂停</span>
              ) : (
                <span className={`status-text ${p.status}`}>{availability[p.status]}</span>
              )}
              {p.current_tasks?.length ? (
                p.current_tasks.map((t) => (
                  <button className="current-task" key={t.id} onClick={() => openTask(t.id)}>
                    <span className="mono">T-{t.id}</span>
                    {t.title}
                    <ArrowUpRight size={12} />
                  </button>
                ))
              ) : (
                <p className="muted small">暂未持有任务</p>
              )}
              <div className="agent-row-foot">
                <span>{ago(p.last_seen_at)}</span>
                {Boolean(p.unread) && <span>{p.unread} 条未读</span>}
              </div>
            </div>
          ))}
          {!agents.length && <Empty title="尚无 Agent" />}
          <button className="panel-link" onClick={() => go('agents')}>
            查看全部参与者
            <ArrowUpRight size={14} />
          </button>
        </section>
        <section className="panel activity-panel">
          <div className="panel-heading">
            <h2>实时活动</h2>
            <select
              aria-label="按参与者筛选活动"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            >
              <option value="">全部参与者</option>
              {participants.map((p) => (
                <option key={p.handle} value={p.handle}>
                  @{p.handle}
                </option>
              ))}
            </select>
          </div>
          <div className="activity-filters">
            <input
              aria-label="按任务筛选活动"
              type="number"
              min="1"
              placeholder="任务 ID"
              value={activityTask}
              onChange={(e) => setActivityTask(e.target.value)}
            />
            <select
              aria-label="按类型筛选活动"
              value={activityType}
              onChange={(e) => setActivityType(e.target.value)}
            >
              <option value="">全部活动类型</option>
              <option value="task.created">创建任务</option>
              <option value="task.status_changed">状态变化</option>
              <option value="message.posted">消息</option>
              <option value="approval.requested">申请审批</option>
              <option value="lock.acquired">取得写入权</option>
              <option value="lock.released">释放写入权</option>
            </select>
          </div>
          <EventList
            actor={actor || undefined}
            taskId={activityTask ? Number(activityTask) : undefined}
            type={activityType || undefined}
          />
        </section>
        <aside className="attention-panel">
          <div className="panel-heading">
            <h2>需要我处理</h2>
            <CircleHelp size={16} />
          </div>
          <ErrorNotice error={inbox.error ?? reviewing.error} />
          {data?.approvals.map((a) => (
            <button
              className="attention-card approval"
              key={`a${a.id}`}
              onClick={() => openTask(a.task_id)}
            >
              <span className="eyebrow">待审批 · {statusNames[a.to_status]}</span>
              <strong>{a.title}</strong>
              <p>{a.reason}</p>
              <span className="small muted">
                T-{a.task_id} · @{a.requester}
                <ArrowUpRight size={13} />
              </span>
            </button>
          ))}
          {data?.attention.map((t) => (
            <button className="attention-card blocked" key={t.id} onClick={() => openTask(t.id)}>
              <span className="eyebrow">
                {t.lease_expired_at ? '租约到期' : t.frozen ? '任务已冻结' : '任务阻塞'}
              </span>
              <strong>{t.title}</strong>
              <span className="small muted">
                T-{t.id} · {t.assignee ? `@${t.assignee}` : '未分配'}
              </span>
            </button>
          ))}
          {reviewing.data
            ?.filter((t) => !data?.approvals.some((a) => a.task_id === t.id))
            .map((t) => (
              <button key={`r${t.id}`} className="attention-card" onClick={() => openTask(t.id)}>
                <span className="eyebrow">等待验收</span>
                <strong>{t.title}</strong>
                <span className="small muted">T-{t.id}</span>
              </button>
            ))}
          {inbox.data
            ?.filter((n) => n.message.kind === 'question')
            .map((n) => (
              <button className="attention-card" key={`n${n.id}`} onClick={() => go('inbox')}>
                <span className="eyebrow">有人在等你的回复</span>
                <p>{n.message.body}</p>
                <span className="small muted">@{n.message.author}</span>
              </button>
            ))}
          {(reviewPage > 0 || reviewing.data?.length === 20) && (
            <div className="pagination">
              <button disabled={reviewPage === 0} onClick={() => setReviewPage(reviewPage - 1)}>
                上一页验收
              </button>
              <button
                disabled={reviewing.data?.length !== 20}
                onClick={() => setReviewPage(reviewPage + 1)}
              >
                下一页验收
              </button>
            </div>
          )}
          {(questionPages.length > 1 || inbox.data?.length === 10) && (
            <div className="pagination">
              <button
                disabled={questionPages.length === 1}
                onClick={() => setQuestionPages(questionPages.slice(0, -1))}
              >
                较新的提问
              </button>
              <button
                disabled={inbox.data?.length !== 10}
                onClick={() => setQuestionPages([...questionPages, inbox.data?.at(-1)?.id])}
              >
                更早的提问
              </button>
            </div>
          )}
          {!data?.approvals.length &&
            !data?.attention.length &&
            !reviewing.data?.length &&
            !inbox.data?.some((n) => n.message.kind === 'question') && (
              <div className="all-clear">
                <span>✓</span>
                <strong>暂时无需介入</strong>
                <p>
                  新的审批、阻塞和问题
                  <br />
                  会集中显示在这里。
                </p>
              </div>
            )}
          <div className="workflow-note">
            <span className="eyebrow">HOW WE WORK</span>
            <h3>
              把工作交给 Agent，
              <br />
              把决定留在人手里。
            </h3>
            <p>
              认领 → 执行 → 提交 → 验收
              <br />
              每一步都留下可追溯的记录。
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
const availability: Record<string, string> = {
  online: '最近活跃',
  working: '正在工作',
  waiting: '等待中',
  offline: '暂无活动',
};
function Participants() {
  const { participants } = useBoard();
  const [selected, setSelected] = useState<Participant>();
  const [freezing, setFreezing] = useState<Participant>();
  const [reason, setReason] = useState('');
  const action = useAction();
  return (
    <>
      <div className="participant-grid">
        {participants.map((p) => (
          <article className="panel participant-card" key={p.handle}>
            <div className="participant-head">
              <Avatar handle={p.handle} />
              <div>
                <h2>@{p.handle}</h2>
                <p className="muted">{p.role ?? 'human'}</p>
              </div>
              <span className={`presence ${p.status}`} />
            </div>
            <div className="participant-info">
              <span title="Agent 状态按最近请求计算；90 秒无请求表示暂无活动，不代表会话已经结束。">
                状态<strong>{p.frozen ? '已暂停' : availability[p.status]}</strong>
              </span>
              <span>
                最后活动<strong>{ago(p.last_seen_at)}</strong>
              </span>
              <span>
                未读消息<strong>{p.unread ?? 0}</strong>
              </span>
              {p.kind === 'agent' && (
                <>
                  <span>
                    已完成<strong>{p.statistics?.completed ?? 0}</strong>
                  </span>
                  <span title="已完成任务首次开工到通过验收的平均耗时，包含等待和返工">
                    平均完成时间
                    <strong>
                      {p.statistics?.average_completion_ms == null
                        ? '—'
                        : `${Math.round(p.statistics.average_completion_ms / 60000)} 分钟`}
                    </strong>
                  </span>
                  <span title="请求修改的验收次数 ÷ 全部验收次数">
                    退回率
                    <strong>
                      {p.statistics?.rejection_rate == null
                        ? '—'
                        : `${Math.round(p.statistics.rejection_rate * 100)}%`}
                    </strong>
                  </span>
                </>
              )}
            </div>
            {p.status_note && <p className="message-body">{p.status_note}</p>}
            <div className="form-actions">
              <button className="button" onClick={() => setSelected(p)}>
                活动与任务
              </button>
              {p.kind === 'agent' && (
                <button
                  className="button subtle"
                  onClick={() => {
                    setFreezing(p);
                    setReason('');
                  }}
                >
                  <Snowflake size={14} />
                  {p.frozen ? '恢复' : '暂停'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {freezing && (
        <Dialog
          title={`${freezing.frozen ? '恢复' : '暂停'} @${freezing.handle}`}
          onClose={() => setFreezing(undefined)}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await action.mutateAsync({
                  operation: 'freeze_participant',
                  input: { handle: freezing.handle, frozen: !freezing.frozen, reason },
                });
                setFreezing(undefined);
              } catch {
                /* Error below. */
              }
            }}
          >
            <p className="muted">暂停后，该 Agent 的所有写操作都会被拒绝，已有写入锁仍会保留。</p>
            <label>
              说明
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
              />
            </label>
            <ErrorNotice error={action.error} />
            <button className="button primary" disabled={action.isPending}>
              确认{freezing.frozen ? '恢复' : '暂停'}
            </button>
          </form>
        </Dialog>
      )}
      {selected && (
        <Dialog
          title={`@${selected.handle} · 活动与任务`}
          onClose={() => setSelected(undefined)}
          wide
        >
          <ParticipantHistory participant={selected} />
        </Dialog>
      )}
    </>
  );
}
function ParticipantHistory({ participant }: { participant: Participant }) {
  const [page, setPage] = useState(0);
  const tasks = useData<TaskSummary[]>('list_tasks', {
    assignee: participant.handle,
    limit: 50,
    offset: page * 50,
  });
  const { openTask } = useBoard();
  return (
    <>
      <h3>
        名下任务 <span className="muted">第 {page + 1} 页</span>
      </h3>
      <ErrorNotice error={tasks.error} />
      {tasks.data?.map((t) => (
        <button className="task-row" key={t.id} onClick={() => openTask(t.id)}>
          <span className="mono">T-{t.id}</span>
          <strong>{t.title}</strong>
          <Badge status={t.status} />
        </button>
      ))}
      {(page > 0 || tasks.data?.length === 50) && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <button disabled={tasks.data?.length !== 50} onClick={() => setPage(page + 1)}>
            下一页
          </button>
        </div>
      )}
      <h3 className="section-gap">活动记录</h3>
      <EventList actor={participant.handle} />
    </>
  );
}
function Decisions() {
  const query = useData<Message[]>('list_decisions', { limit: 200 });
  const { openTask } = useBoard();
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>所有决策</h2>
        <span className="muted">按最近时间排列</span>
      </div>
      <ErrorNotice error={query.error} />
      {query.data?.length ? (
        query.data.map((message) => (
          <div className="decision" key={message.id}>
            <MessageCard message={message} />
            {message.task_id && (
              <button className="text-button" onClick={() => openTask(message.task_id!)}>
                查看 T-{message.task_id}
                <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        ))
      ) : (
        <Empty title="还没有决策记录">发送类型为「决策」的消息，就会汇总到这里。</Empty>
      )}
    </section>
  );
}
function ProjectSettings() {
  const query = useData<Settings>('get_settings');
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <h2>协作规则</h2>
        <span className="tag">Human only</span>
      </div>
      <ErrorNotice error={query.error} />
      {query.data && <SettingsForm initial={query.data} />}
    </section>
  );
}
function SettingsForm({ initial }: { initial: Settings }) {
  const [value, setValue] = useState(initial);
  const [gates, setGates] = useState(JSON.stringify(initial.gates, null, 2));
  const [roles, setRoles] = useState(JSON.stringify(initial.roles, null, 2));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const action = useAction();
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setSaved(false);
        try {
          const input = settingsSchema.parse({
            ...value,
            gates: JSON.parse(gates),
            roles: JSON.parse(roles),
          });
          await action.mutateAsync({ operation: 'put_settings', input });
          setSaved(true);
        } catch (error) {
          setError(errorText(error));
        }
      }}
    >
      <div className="form-row">
        <label>
          认领租约（分钟）
          <input
            type="number"
            min="0.01"
            step="any"
            value={value.lease_minutes}
            onChange={(e) => setValue({ ...value, lease_minutes: Number(e.target.value) })}
            required
          />
        </label>
        <label>
          每人进行中任务上限
          <input
            type="number"
            min="1"
            max="10"
            value={value.max_in_progress}
            onChange={(e) => setValue({ ...value, max_in_progress: Number(e.target.value) })}
            required
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          最多返工次数
          <input
            type="number"
            min="1"
            max="20"
            value={value.max_attempts}
            onChange={(e) => setValue({ ...value, max_attempts: Number(e.target.value) })}
            required
          />
        </label>
        <label>
          Agent 每分钟消息上限
          <input
            type="number"
            min="1"
            max="1000"
            value={value.message_rate_per_minute}
            onChange={(e) =>
              setValue({ ...value, message_rate_per_minute: Number(e.target.value) })
            }
            required
          />
        </label>
      </div>
      <label>
        人工审批规则
        <textarea
          className="code-input"
          rows={12}
          value={gates}
          onChange={(e) => setGates(e.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="muted small">
        规则使用 from、to 和 types 指定转换。例如 draft → open 的 implement 任务必须先经人工发布。
      </p>
      <label>
        各角色可创建的任务类型
        <textarea
          className="code-input"
          rows={10}
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          spellCheck={false}
        />
      </label>
      <ErrorNotice error={error ? new Error(error) : undefined} />
      {saved && (
        <p className="success" role="status">
          设置已保存
        </p>
      )}
      <div className="form-actions">
        <button className="button primary" disabled={action.isPending}>
          保存设置
        </button>
      </div>
    </form>
  );
}
