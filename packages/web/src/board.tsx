import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, BoardClient } from '@baton/client';
import type { BoardEvent, Input, Operation, Participant, TaskStatus } from '@baton/shared';
import { schemas } from '@baton/shared';
import { X, AlertCircle } from 'lucide-react';
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
export const errorText = (error: unknown) =>
  error instanceof ApiError
    ? `${error.message} ${error.next}`
    : error instanceof Error
      ? error.message
      : String(error);
export const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚无活动';
export const ago = (value?: string | null) => {
  if (!value) return '尚无活动';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? '刚刚'
    : minutes < 60
      ? `${minutes} 分钟前`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时前`
        : `${Math.floor(minutes / 1440)} 天前`;
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
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">↗</div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Badge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <i />
      {statusNames[status]}
    </span>
  );
}
export function Avatar({ handle, size = 'normal' }: { handle: string; size?: 'normal' | 'small' }) {
  return (
    <span className={`avatar ${size}`} data-color={handle.charCodeAt(0) % 4}>
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
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
}: {
  taskId?: number;
  actor?: string;
  type?: string;
}) {
  const { api, openTask } = useBoard();
  const [pages, setPages] = useState<(number | undefined)[]>([undefined]);
  useEffect(() => setPages([undefined]), [taskId, actor, type]);
  const before = pages.at(-1);
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
  if (!query.data) return <p className="muted">正在读取活动…</p>;
  const events = query.data;
  if (!events.length && pages.length === 1)
    return <Empty title="协作从这里开始">发布任务或发送一条消息，活动会实时出现在这里。</Empty>;
  return (
    <div className="timeline">
      {events.map((event) => {
        const message = event.payload.message as { body: string; kind: string } | undefined;
        const action = eventNames[event.type] ?? event.type;
        return (
          <article className="event" key={event.id}>
            <div className="event-marker">{message ? '↗' : '•'}</div>
            <div className="event-content">
              <div className="event-meta">
                <strong>{event.actor ? `@${event.actor}` : '系统'}</strong>
                <span>{action}</span>
                {event.task_id && (
                  <button className="text-button mono" onClick={() => openTask(event.task_id!)}>
                    T-{event.task_id}
                  </button>
                )}
                <time>{time(event.created_at)}</time>
              </div>
              {message ? (
                <Markdown>{message.body}</Markdown>
              ) : (
                <p className="event-description">{describeEvent(event)}</p>
              )}
            </div>
          </article>
        );
      })}
      {(pages.length > 1 || events.length === 50) && (
        <div className="pagination">
          <button disabled={pages.length === 1} onClick={() => setPages(pages.slice(0, -1))}>
            较新的活动
          </button>
          <button
            disabled={events.length < 50}
            onClick={() => setPages([...pages, events.at(-1)!.id])}
          >
            更早的活动
          </button>
        </div>
      )}
    </div>
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
  'artifact.added': '添加了产物',
  'inbox.updated': '处理了收件箱',
  'task.frozen': '冻结了任务',
};
function describeEvent(event: BoardEvent): string {
  const p = event.payload;
  if (p.from && p.to)
    return `${statusNames[p.from as TaskStatus] ?? String(p.from)} → ${statusNames[p.to as TaskStatus] ?? String(p.to)}${p.reason ? ` · ${String(p.reason)}` : ''}`;
  if (p.task) return String((p.task as { title: string }).title);
  if (p.reason) return String(p.reason);
  if (p.holder) return `@${String(p.holder)}`;
  if (p.handle) return `@${String(p.handle)}`;
  if (p.ref) return String(p.ref);
  return '';
}
