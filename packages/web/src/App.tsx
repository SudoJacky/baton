import { useI18n, locale } from './i18n.js';
import { setPreferences, usePreferences, type Preferences, type Language } from './preferences.js';
import { useMemo, useState, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BoardClient } from '@baton/client';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Columns3,
  Inbox as InboxIcon,
  LayoutDashboard,
  LockKeyhole,
  MessageSquare,
  Pencil,
  Plus,
  Settings2,
  Users,
  UnlockKeyhole,
  ChevronRight,
  Snowflake,
  ShieldCheck,
  Sun,
  Moon,
} from 'lucide-react';
import type {
  Identity,
  Overview as OverviewData,
  Participant,
  Settings,
  Message,
  TaskStatus,
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
  PageBoundary,
  ago,
  errorText,
  greeting,
  lunarDate,
  statusNames,
  useAction,
  useBoard,
  useData,
  useEvents,
} from './board.js';
import { useGlassLight, useGlassParams, useLiquidGlass } from './glass.js';
import { GlassTuner } from './tuner.js';
import { Inbox, Messages, MessageCard } from './messages.js';
import { NewTask, TaskBoard, TaskDetails } from './tasks.js';

type Page = 'overview' | 'board' | 'inbox' | 'messages' | 'agents' | 'decisions' | 'settings';
const navigation: {
  id: Page;
  label: string;
  icon: typeof Activity;
  group: string;
}[] = [
  {
    id: 'overview',
    label: '总览',
    icon: LayoutDashboard,
    group: '日常',
  },
  {
    id: 'board',
    label: '任务看板',
    icon: Columns3,
    group: '日常',
  },
  {
    id: 'inbox',
    label: '收件箱',
    icon: InboxIcon,
    group: '日常',
  },
  {
    id: 'messages',
    label: '消息',
    icon: MessageSquare,
    group: '日常',
  },
  {
    id: 'agents',
    label: '参与者',
    icon: Users,
    group: '记录与规则',
  },
  {
    id: 'decisions',
    label: '决策日志',
    icon: BookOpen,
    group: '记录与规则',
  },
  {
    id: 'settings',
    label: '项目设置',
    icon: Settings2,
    group: '记录与规则',
  },
];
const navigationGroups = [...new Set(navigation.map((item) => item.group))];
const pageFromHash = (): Page => {
  const id = location.hash.slice(1);
  return navigation.some((item) => item.id === id) ? (id as Page) : 'overview';
};
const todayLabel = (date: Date) =>
  new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric', weekday: 'short' }).format(
    date,
  );
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
  const tr = useI18n();
  const { language } = usePreferences();
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
  const [page, setCurrentPage] = useState<Page>(pageFromHash);
  useEffect(() => {
    const sync = () => setCurrentPage(pageFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    // scrollTo may return a Promise; effects must only return a cleanup function or nothing.
    window.scrollTo(0, 0);
  }, [page]);
  const setPage = (next: Page) => {
    if (next !== page) location.hash = next;
  };
  const [taskId, setTaskId] = useState<number>();
  const [creating, setCreating] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [topbar, setTopbar] = useState<HTMLDivElement | null>(null);
  const [sidebar, setSidebar] = useState<HTMLElement | null>(null);
  const glass = useGlassParams();
  useLiquidGlass(topbar, glass);
  useLiquidGlass(sidebar, glass);
  useGlassLight();
  if (identity.error || identity.data?.participant.kind === 'agent')
    return (
      <div className="centered">
        <ErrorNotice
          error={identity.error ?? new Error(tr('工作空间未返回本地用户，请检查服务配置。'))}
        />
        <button className="button" onClick={() => void identity.refetch()}>
          {tr('重新连接')}
        </button>
      </div>
    );
  if (!identity.data)
    return (
      <div className="centered">
        <Brand />
        <p className="muted">{tr('正在连接工作空间…')}</p>
      </div>
    );
  const current = navigation.find((item) => item.id === page)!;
  const me = identity.data.participant;
  const displayName = me.display_name?.trim();
  const now = new Date();
  const lunar = lunarDate(now);
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
        <aside className="sidebar glass" ref={setSidebar}>
          <Brand />
          <nav aria-label={tr('主导航')}>
            {navigationGroups.map((group) => (
              <div className="nav-group" key={group}>
                <div className="nav-label">{tr(group)}</div>
                {navigation
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <button
                      key={item.id}
                      aria-label={tr(item.label)}
                      title={tr(item.label)}
                      className={page === item.id ? 'active' : ''}
                      aria-current={page === item.id ? 'page' : undefined}
                      onClick={() => setPage(item.id)}
                    >
                      <item.icon size={17} />
                      <span>{tr(item.label)}</span>
                      {item.id === 'inbox' && Boolean(overview.data?.unread) && (
                        <b className="nav-count">{overview.data!.unread}</b>
                      )}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className="profile"
              aria-label={tr('修改昵称')}
              title={tr('修改昵称')}
              onClick={() => setEditingProfile(true)}
            >
              <Avatar handle={me.handle} />
              <span className="profile-details">
                <strong title={displayName}>{displayName || tr('设置昵称')}</strong>
                <span>@{me.handle}</span>
              </span>
              <Pencil className="profile-edit" size={14} aria-hidden="true" />
            </button>
          </div>
        </aside>
        <main className="main-area">
          <div className="topbar glass" ref={setTopbar}>
            <span className="crumbs">
              <span>{tr(current.group)}</span> <ChevronRight size={12} />
              <strong>{tr(current.label)}</strong>
            </span>
            <span className="topbar-date">
              {todayLabel(now)}
              {language === 'zh-CN' && lunar && <span className="lunar"> · 农历{lunar}</span>}
            </span>
            {connection !== 'live' && (
              <div className={`connection ${connection}`} role="status">
                <span className="dot" />
                {connection === 'retrying'
                  ? tr('连接中断，正在重连')
                  : connection === 'unauthorized'
                    ? tr('连接被拒绝，请检查服务配置')
                    : tr('正在连接')}
              </div>
            )}
            <AppearanceControls />
          </div>
          <div className="page">
            <header className="page-header">
              <h1>
                {page === 'overview'
                  ? `${greeting(now)}${displayName ? `${language === 'en' ? ', ' : '，'}${displayName}` : ''}`
                  : tr(current.label)}
              </h1>
              <button className="button primary" onClick={() => setCreating(true)}>
                <Plus size={17} />
                {tr('创建任务')}
              </button>
            </header>
            <ErrorNotice error={overview.error} />
            {overview.data?.locks.map((lock) => (
              <LockBanner key={lock.repository ?? 'legacy'} lock={lock} />
            ))}
            <LockBanner />
            <PageBoundary key={page}>
              {page === 'overview' && <Overview data={overview.data} go={setPage} />}
              {page === 'board' && <TaskBoard />}
              {page === 'inbox' && <Inbox />}
              {page === 'messages' && <Messages />}
              {page === 'agents' && <Participants />}
              {page === 'decisions' && <Decisions />}
              {page === 'settings' && <ProjectSettings />}
            </PageBoundary>
          </div>
        </main>
      </div>
      <GlassTuner />
      {creating && <NewTask onClose={() => setCreating(false)} />}
      {editingProfile && <EditProfile onClose={() => setEditingProfile(false)} />}
      {taskId !== undefined && (
        <TaskDetails key={taskId} id={taskId} onClose={() => setTaskId(undefined)} />
      )}
    </BoardContext.Provider>
  );
}
function AppearanceControls() {
  const tr = useI18n();
  const { theme, language } = usePreferences();
  const [error, setError] = useState(false);
  const update = (change: Partial<Preferences>) => {
    try {
      setPreferences(change);
      setError(false);
    } catch (cause) {
      console.error('Cannot save Baton appearance preferences.', cause);
      setError(true);
    }
  };
  const themeLabel = tr(theme === 'dark' ? '切换到亮色' : '切换到暗色');
  return (
    <div className="appearance-controls" role="group" aria-label={tr('界面设置')}>
      <button
        className="icon-button theme-toggle"
        type="button"
        aria-label={themeLabel}
        title={themeLabel}
        onClick={() => update({ theme: theme === 'dark' ? 'light' : 'dark' })}
      >
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <select
        className="language-select"
        aria-label={tr('界面语言')}
        value={language}
        onChange={(event) => update({ language: event.target.value as Language })}
      >
        <option value="zh-CN" lang="zh-CN">
          中文
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
      {error && (
        <p className="appearance-error" role="alert">
          {tr('无法保存界面设置，请检查浏览器存储权限。')}
        </p>
      )}
    </div>
  );
}
function EditProfile({ onClose }: { onClose: () => void }) {
  const tr = useI18n();
  const { me } = useBoard();
  const [nickname, setNickname] = useState(me.display_name ?? '');
  const action = useAction();
  return (
    <Dialog title={tr('修改昵称')} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await action.mutateAsync({
              operation: 'update_profile',
              input: { display_name: nickname },
            });
            onClose();
          } catch {
            /* Error below; keep the draft available for retry. */
          }
        }}
      >
        <label>
          {tr('昵称')}
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={80}
            autoComplete="nickname"
            placeholder={tr('你希望被怎样称呼')}
            aria-describedby="nickname-hint"
            disabled={action.isPending}
            autoFocus
          />
        </label>
        <p id="nickname-hint" className="muted small">
          {tr('留空则不显示称呼。')}
        </p>
        <ErrorNotice error={action.error} />
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={action.isPending}>
            {tr('取消')}
          </button>
          <button
            className="button primary"
            disabled={action.isPending || nickname.trim() === (me.display_name?.trim() ?? '')}
          >
            {action.isPending ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function LockBanner({ lock }: { lock?: WriteLock }) {
  const tr = useI18n();
  const [mode, setMode] = useState<'acquire' | 'release'>();
  const [reason, setReason] = useState('');
  const [repository, setRepository] = useState('');
  const action = useAction();
  const { openTask, repositories } = useBoard();
  return (
    <>
      <div className={`lock-banner ${lock?.holder ? 'held' : 'idle'}`}>
        <span className="lock-symbol">
          {lock?.holder ? <LockKeyhole size={17} /> : <UnlockKeyhole size={15} />}
        </span>
        <div>
          <strong>
            {lock?.holder ? tr('@{0} 正在持有写入权', lock.holder) : tr('按仓库协调写入')}
          </strong>
          {lock?.holder && (
            <span>
              {lock.repository ?? tr('旧版本写入锁：请检查原工作目录后释放')} ·{' '}
              {ago(lock.acquired_at)}
            </span>
          )}
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
          {lock?.holder ? tr('处理写入锁') : tr('我来改')}
        </button>
      </div>
      {mode && (
        <Dialog
          title={mode === 'acquire' ? tr('取得代码写入权') : tr('释放代码写入权')}
          onClose={() => setMode(undefined)}
        >
          <p className="muted">
            {mode === 'acquire'
              ? tr('选择要修改的仓库。同一仓库的代码任务将等待你完成，结束修改后请回来释放。')
              : tr('请先检查并保存当前工作目录的改动。释放后，原持锁任务会被冻结，避免继续写入。')}
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
                {tr('仓库路径')}
                <input
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  required
                  list="lock-repositories"
                  placeholder={tr('服务所在机器上的 Git 仓库绝对路径')}
                />
                <datalist id="lock-repositories">
                  {repositories.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </label>
            )}
            <label>
              {tr('说明')}
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
              {mode === 'acquire' ? tr('取得写入权') : tr('已检查工作目录，释放写入权')}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
function Overview({ data, go }: { data?: OverviewData; go: (page: Page) => void }) {
  const tr = useI18n();
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
  const metrics: {
    label: string;
    value: number;
    note?: string;
    icon: ReactNode;
    page: Page;
    alert?: boolean;
  }[] = [
    {
      label: tr('全部任务'),
      value: total,
      note: tr('{0} 项已完成', data?.counts.done ?? 0),
      icon: <Columns3 size={17} />,
      page: 'board',
    },
    {
      label: tr('正在进行'),
      value: data?.counts.in_progress ?? 0,
      note: tr('{0} 个 Agent 最近活跃', agents.filter((p) => p.status !== 'offline').length),
      icon: <Activity size={17} />,
      page: 'agents',
    },
    {
      label: tr('等待审批'),
      value: data?.approvals.length ?? 0,
      note: tr('{0} 项等待验收', data?.counts.in_review ?? 0),
      icon: <ShieldCheck size={17} />,
      page: 'board',
      alert: Boolean(data?.approvals.length),
    },
    {
      label: tr('@ 我的消息'),
      value: data?.unread ?? 0,
      icon: <InboxIcon size={17} />,
      page: 'inbox',
    },
  ];
  return (
    <>
      <div className="metrics">
        {metrics.map((m) => (
          <button
            className={`metric ${m.alert ? 'alert' : ''}`}
            aria-label={m.label}
            key={m.page}
            onClick={() => go(m.page)}
          >
            <span>
              {m.label}
              {m.icon}
            </span>
            <strong>{m.value.toLocaleString(locale())}</strong>
            {m.note && <small>{m.note}</small>}
          </button>
        ))}
      </div>
      <FlowBar counts={data?.counts} onOpen={() => go('board')} />
      <div className="overview-grid">
        <section className="panel agents-panel">
          <div className="panel-heading">
            <h2>{tr('Agent 状态')}</h2>
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
                <span className="tag danger">{tr('已暂停')}</span>
              ) : (
                <span className={`status-text ${p.status}`}>{tr(availability[p.status])}</span>
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
                <p className="muted small">{tr('暂未持有任务')}</p>
              )}
              <div className="agent-row-foot">
                <span>{ago(p.last_seen_at)}</span>
                {Boolean(p.unread) && <span>{tr('{0} 条未读', p.unread)}</span>}
              </div>
            </div>
          ))}
          {!agents.length && <Empty title={tr('尚无 Agent')} />}
          <button className="panel-link" onClick={() => go('agents')}>
            {tr('查看全部参与者')}
            <ArrowUpRight size={14} />
          </button>
        </section>
        <section className="panel activity-panel">
          <div className="panel-heading">
            <h2>{tr('实时活动')}</h2>
            <select
              aria-label={tr('按参与者筛选活动')}
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            >
              <option value="">{tr('全部参与者')}</option>
              {participants.map((p) => (
                <option key={p.handle} value={p.handle}>
                  @{p.handle}
                </option>
              ))}
            </select>
          </div>
          <div className="activity-filters">
            <input
              aria-label={tr('按任务筛选活动')}
              type="number"
              min="1"
              placeholder={tr('任务 ID')}
              value={activityTask}
              onChange={(e) => setActivityTask(e.target.value)}
            />
            <select
              aria-label={tr('按类型筛选活动')}
              value={activityType}
              onChange={(e) => setActivityType(e.target.value)}
            >
              <option value="">{tr('全部活动类型')}</option>
              <option value="task.created">{tr('创建任务')}</option>
              <option value="task.status_changed">{tr('状态变化')}</option>
              <option value="message.posted">{tr('消息')}</option>
              <option value="approval.requested">{tr('申请审批')}</option>
              <option value="lock.acquired">{tr('取得写入权')}</option>
              <option value="lock.released">{tr('释放写入权')}</option>
            </select>
          </div>
          <EventList
            actor={actor || undefined}
            taskId={activityTask ? Number(activityTask) : undefined}
            type={activityType || undefined}
            compact
          />
        </section>
        <aside className="attention-panel">
          <div className="panel-heading">
            <h2>{tr('需要我处理')}</h2>
          </div>
          <ErrorNotice error={inbox.error ?? reviewing.error} />
          {data?.approvals.map((a) => (
            <button
              className="attention-card approval"
              key={`a${a.id}`}
              onClick={() => openTask(a.task_id)}
            >
              <span className="eyebrow">{tr('待审批 · {0}', tr(statusNames[a.to_status]))}</span>
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
                {t.lease_expired_at ? tr('租约到期') : t.frozen ? tr('任务已冻结') : tr('任务阻塞')}
              </span>
              <strong>{t.title}</strong>
              <span className="small muted">
                T-{t.id} · {t.assignee ? `@${t.assignee}` : tr('未分配')}
              </span>
            </button>
          ))}
          {reviewing.data
            ?.filter((t) => !data?.approvals.some((a) => a.task_id === t.id))
            .map((t) => (
              <button key={`r${t.id}`} className="attention-card" onClick={() => openTask(t.id)}>
                <span className="eyebrow">{tr('等待验收')}</span>
                <strong>{t.title}</strong>
                <span className="small muted">T-{t.id}</span>
              </button>
            ))}
          {inbox.data
            ?.filter((n) => n.message.kind === 'question')
            .map((n) => (
              <button className="attention-card" key={`n${n.id}`} onClick={() => go('inbox')}>
                <span className="eyebrow">{tr('有人在等你的回复')}</span>
                <p>{n.message.body}</p>
                <span className="small muted">@{n.message.author}</span>
              </button>
            ))}
          {(reviewPage > 0 || reviewing.data?.length === 20) && (
            <div className="pagination">
              <button disabled={reviewPage === 0} onClick={() => setReviewPage(reviewPage - 1)}>
                {tr('上一页验收')}
              </button>
              <button
                disabled={reviewing.data?.length !== 20}
                onClick={() => setReviewPage(reviewPage + 1)}
              >
                {tr('下一页验收')}
              </button>
            </div>
          )}
          {(questionPages.length > 1 || inbox.data?.length === 10) && (
            <div className="pagination">
              <button
                disabled={questionPages.length === 1}
                onClick={() => setQuestionPages(questionPages.slice(0, -1))}
              >
                {tr('较新的提问')}
              </button>
              <button
                disabled={inbox.data?.length !== 10}
                onClick={() => setQuestionPages([...questionPages, inbox.data?.at(-1)?.id])}
              >
                {tr('更早的提问')}
              </button>
            </div>
          )}
          {!data?.approvals.length &&
            !data?.attention.length &&
            !reviewing.data?.length &&
            !inbox.data?.some((n) => n.message.kind === 'question') && (
              <div className="all-clear">
                <strong>{tr('暂时无需介入')}</strong>
              </div>
            )}
        </aside>
      </div>
    </>
  );
}
const flow: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'pending', label: '待开工', statuses: ['draft', 'open', 'claimed'] },
  { key: 'progress', label: '进行中', statuses: ['in_progress'] },
  { key: 'blocked', label: '受阻或待修改', statuses: ['blocked', 'changes_requested'] },
  { key: 'review', label: '待验收', statuses: ['in_review'] },
  { key: 'done', label: '已完成', statuses: ['done'] },
];
function FlowBar({ counts = {}, onOpen }: { counts?: OverviewData['counts']; onOpen: () => void }) {
  const tr = useI18n();
  const [hover, setHover] = useState<string>();
  const rows = flow.map((f) => ({
    ...f,
    label: tr(f.label),
    value: f.statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0),
  }));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const focused = rows.find((r) => r.key === hover);
  const share = (value: number) => Math.round((value / (total || 1)) * 100);
  const dim = (key: string) => (hover && hover !== key ? 'dim' : '');
  return (
    <section className="panel flow-panel" aria-labelledby="flow-title">
      <div className="flow-head">
        <h2 id="flow-title">{tr('任务流向')}</h2>
        <span className="flow-readout" aria-live="polite">
          {focused
            ? tr('{0} · {1} 项 · {2}%', focused.label, focused.value, share(focused.value))
            : total
              ? tr('共 {0} 项，不含已取消', total)
              : tr('还没有任务')}
        </span>
      </div>
      <div
        className="flow-bar"
        role="img"
        aria-label={rows.map((r) => tr('{0} {1} 项', r.label, r.value)).join(', ')}
        onMouseLeave={() => setHover(undefined)}
      >
        {total ? (
          rows
            .filter((r) => r.value)
            .map((r) => (
              <span
                key={r.key}
                className={`flow-seg flow-${r.key} ${dim(r.key)}`}
                style={{ flexGrow: r.value }}
                onMouseEnter={() => setHover(r.key)}
              />
            ))
        ) : (
          <span className="flow-seg flow-empty" />
        )}
      </div>
      <ul className="flow-legend">
        {rows.map((r) => (
          <li key={r.key}>
            <button
              className={dim(r.key)}
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(r.key)}
              onBlur={() => setHover(undefined)}
              onClick={onOpen}
            >
              <i className={`flow-swatch flow-${r.key}`} />
              <span>{r.label}</span>
              <strong>{r.value}</strong>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
const availability: Record<Participant['status'], string> = {
  online: '最近活跃',
  working: '正在工作',
  waiting: '等待中',
  offline: '暂无活动',
};
function Participants() {
  const tr = useI18n();
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
              <span
                title={tr(
                  'Agent 状态按最近请求计算；90 秒无请求表示暂无活动，不代表会话已经结束。',
                )}
              >
                {tr('状态')}
                <strong>{p.frozen ? tr('已暂停') : tr(availability[p.status])}</strong>
              </span>
              <span>
                {tr('最后活动')}
                <strong>{ago(p.last_seen_at)}</strong>
              </span>
              <span>
                {tr('未读消息')}
                <strong>{p.unread ?? 0}</strong>
              </span>
              {p.kind === 'agent' && (
                <>
                  <span>
                    {tr('已完成')}
                    <strong>{p.statistics?.completed ?? 0}</strong>
                  </span>
                  <span title={tr('已完成任务首次开工到通过验收的平均耗时，包含等待和返工')}>
                    {tr('平均完成时间')}
                    <strong>
                      {p.statistics?.average_completion_ms == null
                        ? '—'
                        : tr('{0} 分钟', Math.round(p.statistics.average_completion_ms / 60000))}
                    </strong>
                  </span>
                  <span title={tr('请求修改的验收次数 ÷ 全部验收次数')}>
                    {tr('退回率')}
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
                {tr('活动与任务')}
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
                  {p.frozen ? tr('恢复') : tr('暂停')}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {freezing && (
        <Dialog
          title={`${freezing.frozen ? tr('恢复') : tr('暂停')} @${freezing.handle}`}
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
            <p className="muted">
              {tr('暂停后，该 Agent 的所有写操作都会被拒绝，已有写入锁仍会保留。')}
            </p>
            <label>
              {tr('说明')}
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
              {tr('确认{0}', freezing.frozen ? tr('恢复') : tr('暂停'))}
            </button>
          </form>
        </Dialog>
      )}
      {selected && (
        <Dialog
          title={tr('@{0} · 活动与任务', selected.handle)}
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
  const tr = useI18n();
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
        {tr('名下任务')}
        <span className="muted">{tr('第 {0} 页', page + 1)}</span>
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
            {tr('上一页')}
          </button>
          <button disabled={tasks.data?.length !== 50} onClick={() => setPage(page + 1)}>
            {tr('下一页')}
          </button>
        </div>
      )}
      <h3 className="section-gap">{tr('活动记录')}</h3>
      <EventList actor={participant.handle} />
    </>
  );
}
function Decisions() {
  const tr = useI18n();
  const query = useData<Message[]>('list_decisions', { limit: 200 });
  const { openTask } = useBoard();
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{tr('所有决策')}</h2>
        <span className="muted">{tr('按最近时间排列')}</span>
      </div>
      <ErrorNotice error={query.error} />
      {query.data?.length ? (
        query.data.map((message) => (
          <div className="decision" key={message.id}>
            <MessageCard message={message} />
            {message.task_id && (
              <button className="text-button" onClick={() => openTask(message.task_id!)}>
                {tr('查看 T-{0}', message.task_id)}
                <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        ))
      ) : (
        <Empty title={tr('还没有决策记录')}>
          {tr('发送类型为「决策」的消息，就会汇总到这里。')}
        </Empty>
      )}
    </section>
  );
}
function ProjectSettings() {
  const tr = useI18n();
  const query = useData<Settings>('get_settings');
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <h2>{tr('协作规则')}</h2>
        <span className="tag">{tr('仅限人工')}</span>
      </div>
      <ErrorNotice error={query.error} />
      {query.data && <SettingsForm initial={query.data} />}
    </section>
  );
}
function SettingsForm({ initial }: { initial: Settings }) {
  const tr = useI18n();
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
      <label>
        {tr('审批方式')}
        <select
          value={value.approval_mode}
          onChange={(e) =>
            setValue({ ...value, approval_mode: e.target.value as Settings['approval_mode'] })
          }
        >
          <option value="plan">{tr('仅审批计划')}</option>
          <option value="custom">{tr('自定义审批规则')}</option>
        </select>
      </label>
      {value.approval_mode === 'plan' && (
        <>
          <p className="muted small">
            {tr(
              '计划批准后，实现、独立验收和返工自动推进。达到返工上限或报告合入冲突时转交人工。由主 Agent 调度子 Agent，服务本身不启动模型。',
            )}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.merge_approval}
              onChange={(e) => setValue({ ...value, merge_approval: e.target.checked })}
            />
            {tr('分支合入前需要人工审批')}
          </label>
          <p className="muted small">
            {tr('仅作用于「合入」任务；使用现有分支顺序工作时，无需增加合入任务。')}
          </p>
        </>
      )}
      <div className="form-row">
        <label>
          {tr('认领租约（分钟）')}
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
          {tr('每人进行中任务上限')}
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
          {tr('最多返工次数')}
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
          {tr('Agent 每分钟消息上限')}
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
      {value.approval_mode === 'custom' && (
        <label>
          {tr('人工审批规则')}
          <textarea
            className="code-input"
            rows={12}
            value={gates}
            onChange={(e) => setGates(e.target.value)}
            spellCheck={false}
          />
        </label>
      )}
      <label>
        {tr('各角色可创建的任务类型')}
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
          {tr('设置已保存')}
        </p>
      )}
      <div className="form-actions">
        <button className="button primary" disabled={action.isPending}>
          {tr('保存设置')}
        </button>
      </div>
    </form>
  );
}
