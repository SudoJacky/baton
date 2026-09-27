import { useI18n, tr, locale } from './i18n.js';
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, BoardClient } from '@baton/client';
import type { BoardEvent, Input, Operation, Participant, TaskStatus } from '@baton/shared';
import { schemas } from '@baton/shared';
import { X, AlertCircle } from 'lucide-react';
import { useLiquidGlass } from './glass.js';
import { Markdown } from './Markdown.js';

export const statusNames: Record<TaskStatus, string> = {
  draft: '草稿',
  open: '待认领',
  claimed: '已认领',
  in_progress: '进行中',
  blocked: '已阻塞',
  in_review: '待验收',
  changes_requested: '待修改',
  done: '已完成',
  cancelled: '已取消',
};
export const typeNames = {
  plan: '规划',
  implement: '实现',
  test: '测试',
  review: '审查',
  bug: '缺陷',
  question: '问题',
  merge: '合入',
};
export const kindNames: Record<string, string> = {
  comment: '讨论',
  question: '提问',
  decision: '决策',
  report: '报告',
  handoff: '交接',
  system: '系统',
};
export const mentionStateNames: Record<string, string> = {
  unread: '未读',
  read: '已读',
  resolved: '已处理',
};
const lunarDays = ['初', '十', '廿', '三'];
const numerals = '十一二三四五六七八九';
/** 农历日期，例如「八月十六」。浏览器不支持农历时返回空字符串。 */
export const lunarDate = (date = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric',
    }).formatToParts(date);
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    if (!month || !day) return '';
    const name =
      day === 10
        ? '初十'
        : day === 20
          ? '二十'
          : day === 30
            ? '三十'
            : `${lunarDays[Math.floor(day / 10)]}${numerals[day % 10]}`;
    return `${month}${name}`;
  } catch {
    return '';
  }
};
export const greeting = (date = new Date()) => {
  const hour = date.getHours();
  return hour < 5
    ? tr('夜深了')
    : hour < 11
      ? tr('早上好')
      : hour < 13
        ? tr('中午好')
        : hour < 18
          ? tr('下午好')
          : tr('晚上好');
};
export const errorText = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message} ${error.next}`
    : error instanceof Error
      ? error.message
      : String(error);
export const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString(locale(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : tr('尚无活动');
export const ago = (value?: string | null) => {
  if (!value) return tr('尚无活动');
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? tr('刚刚')
    : minutes < 60
      ? tr('{0} 分钟前', minutes)
      : minutes < 1440
        ? tr('{0} 小时前', Math.floor(minutes / 60))
        : tr('{0} 天前', Math.floor(minutes / 1440));
};
type BoardContextType = {
  api: BoardClient;
  me: Participant;
  openTask: (id: number) => void;
  participants: Participant[];
  repositories: string[];
};
export const BoardContext = createContext<BoardContextType | null>(null);
export function useBoard() {
  const value = useContext(BoardContext);
  if (!value) throw new Error('Board context missing');
  return value;
}
export function useData<T>(
  operation: Operation,
  input: Record<string, unknown> = {},
  enabled = true,
) {
  const { api } = useBoard();
  return useQuery({
    queryKey: ['board', operation, input],
    queryFn: async () => (await api.call<T>(operation, schemas[operation].parse(input))).data,
    enabled,
  });
}
export function useAction() {
  const { api } = useBoard();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: ({ operation, input }: { operation: Operation; input: Input<Operation> }) =>
      api.call(operation, input),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['board'] });
    },
  });
}
export function useEvents(api: BoardClient, snapshotCursor?: number) {
  const queries = useQueryClient();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'retrying' | 'unauthorized'>(
    'connecting',
  );
  const snapshot = useRef(snapshotCursor);
  snapshot.current = snapshotCursor;
  const ready = snapshotCursor !== undefined;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let cursor = snapshot.current!;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await api.stream(
            cursor,
            (event: BoardEvent) => {
              cursor = event.id;
              if (!refresh)
                refresh = setTimeout(() => {
                  refresh = undefined;
                  void queries.invalidateQueries({ queryKey: ['board'] });
                }, 120);
            },
            controller.signal,
            () => setConnection('live'),
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && [401, 403].includes(error.status)) {
            setConnection('unauthorized');
            return;
          }
        }
        if (controller.signal.aborted) return;
        setConnection('retrying');
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(retry);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          retry = setTimeout(done, 2000);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    };
    void run();
    return () => {
      controller.abort();
      clearTimeout(refresh);
      clearTimeout(retry);
    };
  }, [api, queries, ready]);
  return connection;
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <div className="error-notice" role="alert">
      <AlertCircle size={17} />
      <span>{errorText(error)}</span>
    </div>
  ) : null;
}
/** 页面渲染出错时显示原因和恢复入口，而不是整屏空白。 */
export class PageBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error('页面渲染失败', error);
  }
  render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="panel page-error">
        <ErrorNotice error={this.state.error} />
        <p className="muted">{tr('这个页面渲染时出错了，其他页面不受影响。')}</p>
        <button className="button" onClick={() => location.reload()}>
          {tr('重新加载')}
        </button>
      </div>
    );
  }
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true" />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Badge({ status }: { status: TaskStatus }) {
  const tr = useI18n();
  return (
    <span className={`badge status-${status}`}>
      <i />
      {tr(statusNames[status])}
    </span>
  );
}
export function Avatar({ handle, size = 'normal' }: { handle: string; size?: 'normal' | 'small' }) {
  const tone = [...handle].reduce((sum, c) => sum * 31 + c.charCodeAt(0), 7) >>> 0;
  return (
    <span className={`avatar ${size}`} data-color={tone % 6} aria-hidden="true">
      {handle.slice(0, 2).toUpperCase()}
    </span>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const tr = useI18n();
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [dialog]);
  // 对话框里是表单与正文，折射保持克制、不做色散；模糊沿用 CSS 里更重的磨砂
  useLiquidGlass(dialog, { displacementScale: 20 });
  return (
    <dialog
      ref={setDialog}
      className={wide ? 'dialog glass wide' : 'dialog glass'}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label={tr('关闭')} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function EventList({
  taskId,
  actor,
  type,
  compact = false,
}: {
  taskId?: number;
  actor?: string;
  type?: string;
  /** 限高滚动并折叠长内容，适合总览这类扫读场景。 */
  compact?: boolean;
}) {
  const tr = useI18n();
  const { api, openTask } = useBoard();
  const [pages, setPages] = useState<(number | undefined)[]>([undefined]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const timeline = useRef<HTMLDivElement>(null);
  useEffect(() => setPages([undefined]), [taskId, actor, type]);
  const before = pages.at(-1);
  useEffect(() => {
    if (compact) timeline.current?.scrollTo(0, 0);
  }, [compact, taskId, actor, type, before]);
  const query = useQuery({
    queryKey: ['board', 'timeline', taskId, actor, type, before],
    queryFn: async () =>
      (
        await api.call<BoardEvent[]>('get_events', {
          order: 'desc',
          before,
          task_id: taskId,
          actor,
          type,
          limit: 50,
        })
      ).data,
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <p className="muted">{tr('正在读取活动…')}</p>;
  const events = query.data;
  if (!events.length && pages.length === 1)
    return (
      <Empty title={tr('协作从这里开始')}>
        {tr('发布任务或发送一条消息，活动会实时出现在这里。')}
      </Empty>
    );
  return (
    <>
      <div
        className={`timeline${compact ? ' timeline-compact' : ''}`}
        ref={timeline}
        role={compact ? 'region' : undefined}
        aria-label={compact ? tr('实时活动列表') : undefined}
        tabIndex={compact ? 0 : undefined}
      >
        {events.map((event) => {
          const message = event.payload.message as { body: string; kind: string } | undefined;
          const action = tr(eventNames[event.type] ?? event.type);
          const body = message?.body ?? describeEvent(event);
          const collapsible = compact && body.length > 160;
          const isExpanded = expanded.has(event.id);
          return (
            <article className={`event ${message ? 'has-message' : ''}`} key={event.id}>
              <div className="event-marker" aria-hidden="true" />
              <div className="event-content">
                <div className="event-meta">
                  <strong>{event.actor ? `@${event.actor}` : tr('系统')}</strong>
                  <span>{action}</span>
                  {event.task_id && (
                    <button className="text-button mono" onClick={() => openTask(event.task_id!)}>
                      T-{event.task_id}
                    </button>
                  )}
                  <time>{time(event.created_at)}</time>
                </div>
                <div className={collapsible && !isExpanded ? 'clamped' : undefined}>
                  {message ? (
                    <Markdown>{body}</Markdown>
                  ) : (
                    <p className="event-description">{body}</p>
                  )}
                </div>
                {collapsible && (
                  <button
                    className="text-button small"
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(event.id)) next.delete(event.id);
                        else next.add(event.id);
                        return next;
                      })
                    }
                  >
                    {isExpanded ? tr('收起全文') : tr('展开全文')}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {(pages.length > 1 || events.length === 50) && (
        <div className="pagination">
          <button disabled={pages.length === 1} onClick={() => setPages(pages.slice(0, -1))}>
            {tr('较新的活动')}
          </button>
          <button
            disabled={events.length < 50}
            onClick={() => setPages([...pages, events.at(-1)!.id])}
          >
            {tr('更早的活动')}
          </button>
        </div>
      )}
    </>
  );
}
const eventNames: Record<string, string> = {
  'task.created': '创建了任务',
  'task.claimed': '认领了任务',
  'task.status_changed': '更新了状态',
  'task.updated': '更新了任务',
  'task.released': '释放了任务',
  'task.reassigned': '改派了任务',
  'message.posted': '发送了消息',
  'lock.acquired': '取得写入权',
  'lock.released': '释放了写入权',
  'approval.requested': '请求人工审批',
  'approval.rejected': '驳回了审批',
  'task.lease_expired': '租约到期',
  'task.lease_expired_locked': '租约到期，保留写入锁',
  'task.escalated': '返工次数达到上限',
  'agent.online': '上线了',
  'agent.offline': '离线了',
  'agent.frozen': '暂停了 Agent',
  'agent.resumed': '恢复了 Agent',
  'agent.status_changed': '更新了在线状态',
  'channel.created': '创建了会话',
  'settings.updated': '更新了项目设置',
  'participant.updated': '修改了昵称',
  'artifact.added': '添加了产物',
  'inbox.updated': '处理了收件箱',
  'task.frozen': '冻结了任务',
};
function describeEvent(event: BoardEvent): string {
  const p = event.payload;
  if (event.type === 'participant.updated')
    return p.display_name ? String(p.display_name) : tr('已清除昵称');
  if (p.from && p.to)
    return `${tr(statusNames[p.from as TaskStatus] ?? String(p.from))} → ${tr(statusNames[p.to as TaskStatus] ?? String(p.to))}${p.reason ? ` · ${String(p.reason)}` : ''}`;
  if (p.task) return String((p.task as { title: string }).title);
  if (p.reason) return String(p.reason);
  if (p.holder) return `@${String(p.holder)}`;
  if (p.handle) return `@${String(p.handle)}`;
  if (p.ref) return String(p.ref);
  return '';
}
