import { useState } from 'react';
import type { AttentionQueue as Queue, AttentionItem } from '@baton/shared';
import { ArrowUpRight } from 'lucide-react';
import { useI18n } from './i18n.js';
import { ago, ErrorNotice, useAction, useBoard, useData } from './board.js';
import { Composer } from './messages.js';
import { actionNames } from './task-ui.js';

const queueKinds = {
  all: '全部待办',
  approval: '待审批',
  blocker: '异常与阻塞',
  review: '待验收',
  question: '待回复',
};
export function AttentionQueue() {
  const tr = useI18n();
  const { openTask } = useBoard();
  const [kind, setKind] = useState<keyof typeof queueKinds>('all');
  const [sort, setSort] = useState('priority');
  const [page, setPage] = useState(0);
  const [reply, setReply] = useState<string>();
  const queue = useData<Queue>('get_attention_queue', { kind, sort, limit: 10, offset: page * 10 });
  const action = useAction();
  const siblings = [
    ...new Set((queue.data?.items ?? []).flatMap((item) => (item.task ? [item.task.id] : []))),
  ];
  const destination = (item: AttentionItem) => {
    const message = item.mention!.message;
    return message.task_id
      ? { task_id: message.task_id }
      : message.channel_name?.startsWith('dm:') || !message.channel_name
        ? { to: message.author }
        : { channel: message.channel_name };
  };
  return (
    <aside className="attention-panel work-queue">
      <div className="panel-heading">
        <h2>{tr('需要我处理')}</h2>
        <span className="tag">{queue.data?.total ?? '—'}</span>
      </div>
      <div className="queue-filters">
        <select
          aria-label={tr('待办类型')}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            setPage(0);
          }}
        >
          {Object.entries(queueKinds).map(([key, label]) => (
            <option key={key} value={key}>
              {tr(label)}
            </option>
          ))}
        </select>
        <select
          aria-label={tr('待办排序')}
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            setPage(0);
          }}
        >
          <option value="priority">{tr('优先级优先')}</option>
          <option value="waiting">{tr('等待最久')}</option>
          <option value="impact">{tr('影响范围优先')}</option>
        </select>
      </div>
      <ErrorNotice error={queue.error ?? action.error} />
      {queue.data?.items.map((item) => (
        <article className={`attention-card ${item.kind}`} key={item.id}>
          <div className="queue-item-meta">
            <span className="eyebrow">{tr(queueKinds[item.kind])}</span>
            <span className={`priority priority-${item.priority}`}>{item.priority}</span>
          </div>
          <strong>{item.title}</strong>
          <p>{item.reason}</p>
          <div className="queue-age">
            <time dateTime={item.since} title={new Date(item.since).toLocaleString()}>
              {tr('自 {0} 起等待', ago(item.since))}
            </time>
            {item.impact > 0 && <span>{tr('关联 {0} 项未完成任务', item.impact)}</span>}
          </div>
          {item.handoff && (
            <p className="queue-next">
              {tr(
                '下一步：{0} · {1}',
                tr(actionNames[item.handoff.next_action.action]),
                item.handoff.next_action.actor === 'human'
                  ? tr('人工')
                  : `@${item.handoff.next_action.actor}`,
              )}
            </p>
          )}
          <div className="queue-actions">
            {item.task && (
              <button className="text-button" onClick={() => openTask(item.task!.id, siblings)}>
                {tr('查看并处理')}
                <ArrowUpRight size={13} />
              </button>
            )}
            {item.mention && (
              <>
                <button
                  className="text-button"
                  onClick={() => setReply(reply === item.id ? undefined : item.id)}
                >
                  {reply === item.id ? tr('收起回复') : tr('回复')}
                </button>
                <button
                  className="text-button"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      operation: 'mark_read',
                      input: { ids: [item.mention!.id], resolve: true },
                    })
                  }
                >
                  {tr('标记已处理')}
                </button>
              </>
            )}
          </div>
          {reply === item.id && item.mention && (
            <>
              <p className="muted small">{tr('发送回复后，该提问会标记为已处理。')}</p>
              <Composer
                destination={destination(item)}
                replyTo={item.mention.message_id}
                onSent={() => setReply(undefined)}
              />
            </>
          )}
        </article>
      ))}
      {queue.data?.total === 0 && (
        <div className="all-clear">
          <strong>{tr('暂时无需介入')}</strong>
        </div>
      )}
      {!queue.data && !queue.error && <p className="muted">{tr('正在读取待办…')}</p>}
      {(page > 0 || (queue.data?.total ?? 0) > 10) && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            {tr('上一页')}
          </button>
          <span>{tr('第 {0} 页', page + 1)}</span>
          <button
            disabled={(page + 1) * 10 >= (queue.data?.total ?? 0)}
            onClick={() => setPage(page + 1)}
          >
            {tr('下一页')}
          </button>
        </div>
      )}
    </aside>
  );
}
