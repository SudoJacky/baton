import { useI18n } from './i18n.js';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Markdown } from './Markdown.js';
import { ArrowUpRight, Check, CheckCheck, Hash, MessageSquare, Send } from 'lucide-react';
import type { Channel, Mention, Message } from '@baton/shared';
import {
  Avatar,
  Empty,
  ErrorNotice,
  kindNames,
  mentionStateNames,
  time,
  useAction,
  useBoard,
  useData,
} from './board.js';

export function Composer({
  destination,
  replyTo,
  onSent,
}: {
  destination: { task_id: number } | { channel: string } | { to: string };
  replyTo?: number;
  onSent?: () => void;
}) {
  const tr = useI18n();
  const [body, setBody] = useState('');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const suggestionsId = useId();
  const [kind, setKind] = useState('comment');
  const action = useAction();
  const { participants } = useBoard();
  const match = body.slice(0, caret).match(/(?:^|\s)@([a-z0-9_:-]*)$/);
  const suggestions =
    match && !dismissed
      ? [
          ...new Set([
            'human',
            ...('task_id' in destination ? ['assignee'] : []),
            ...participants.map((p) => p.handle),
            ...participants
              .filter((p) => p.kind === 'agent' && p.role)
              .map((p) => `role:${p.role}`),
          ]),
        ].filter((h) => h.startsWith(match[1] ?? ''))
      : [];
  const choose = (handle: string) => {
    const prefix = body.slice(0, caret).replace(/@[a-z0-9_:-]*$/, `@${handle} `);
    setBody(prefix + body.slice(caret));
    setCaret(prefix.length);
    setDismissed(true);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(prefix.length, prefix.length);
    });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await action.mutateAsync({
        operation: 'post_message',
        input: { ...destination, body, kind: kind as 'comment', reply_to: replyTo },
      });
      setBody('');
      onSent?.();
    } catch {
      /* Error is shown below. */
    }
  };
  return (
    <form className="composer" onSubmit={submit}>
      <label
        className="sr-only"
        htmlFor={`compose-${replyTo ?? 'new'}-${JSON.stringify(destination)}`}
      >
        {tr('消息内容')}
      </label>
      <textarea
        ref={textarea}
        id={`compose-${replyTo ?? 'new'}-${JSON.stringify(destination)}`}
        placeholder={
          replyTo ? tr('回复消息 #{0}…', replyTo) : tr('写下进展、问题或决策，输入 @ 提及参与者…')
        }
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setCaret(e.target.selectionStart);
          setSelected(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length ? suggestionsId : undefined}
        aria-activedescendant={
          suggestions.length
            ? `${suggestionsId}-${Math.min(selected, suggestions.length - 1)}`
            : undefined
        }
        onKeyDown={(e) => {
          if (!suggestions.length) {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(true);
          } else if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            setSelected(
              (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) %
                suggestions.length,
            );
          } else if (['Enter', 'Tab'].includes(e.key)) {
            e.preventDefault();
            choose(suggestions[Math.min(selected, suggestions.length - 1)]!);
          }
        }}
        required
        rows={3}
        maxLength={20000}
      />
      {suggestions.length > 0 && (
        <div
          id={suggestionsId}
          role="listbox"
          className="mention-suggestions"
          aria-label={tr('提及建议')}
        >
          {suggestions.map((handle, index) => (
            <button
              id={`${suggestionsId}-${index}`}
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              type="button"
              key={handle}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(handle)}
            >
              @{handle}
            </button>
          ))}
        </div>
      )}
      <div className="composer-footer">
        <select aria-label={tr('消息类型')} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="comment">{tr('讨论')}</option>
          <option value="question">{tr('提问')}</option>
          <option value="decision">{tr('决策')}</option>
          <option value="report">{tr('报告')}</option>
          <option value="handoff">{tr('交接')}</option>
        </select>
        <span className="composer-hint">{tr('Ctrl / ⌘ + Enter 发送')}</span>
        <button className="button primary" disabled={action.isPending || !body.trim()}>
          <Send size={14} />
          {action.isPending ? tr('发送中…') : tr('发送')}
        </button>
      </div>
      <ErrorNotice error={action.error} />
    </form>
  );
}
export function Messages() {
  const tr = useI18n();
  const { participants, me } = useBoard();
  const channels = useData<Channel[]>('list_channels');
  const [destination, setDestination] = useState<{ channel: string } | { to: string }>({
    channel: 'general',
  });
  const [reply, setReply] = useState<number>();
  const thread = useData<Message[]>('get_thread', { ...destination, limit: 200 });
  const name = 'channel' in destination ? `# ${destination.channel}` : `@${destination.to}`;
  return (
    <div className="messages-layout">
      <aside className="channel-list">
        <h3>{tr('频道')}</h3>
        {(channels.data ?? [])
          .filter((c) => c.kind === 'channel')
          .map((c) => (
            <button
              key={c.id}
              className={
                'channel' in destination && destination.channel === c.name ? 'selected' : ''
              }
              onClick={() => {
                setDestination({ channel: c.name });
                setReply(undefined);
              }}
            >
              <Hash size={16} />
              {c.name}
            </button>
          ))}
        <h3>{tr('私信')}</h3>
        {participants
          .filter((p) => p.handle !== me.handle)
          .map((p) => (
            <button
              key={p.handle}
              className={'to' in destination && destination.to === p.handle ? 'selected' : ''}
              onClick={() => {
                setDestination({ to: p.handle });
                setReply(undefined);
              }}
            >
              <Avatar handle={p.handle} size="small" />
              {p.handle}
            </button>
          ))}
      </aside>
      <section className="panel conversation">
        <div className="panel-heading">
          <h2>{name}</h2>
          <span className="muted">{tr('{0} 条消息 · 最近 200 条', thread.data?.length ?? 0)}</span>
        </div>
        <ErrorNotice error={channels.error ?? thread.error} />
        <div className="message-list">
          {!thread.data?.length ? (
            <Empty title={tr('还没有消息')}>
              {tr('把需要讨论的事留在这里，让下一位参与者接得上。')}
            </Empty>
          ) : (
            thread.data.map((m) => (
              <MessageCard key={m.id} message={m} onReply={() => setReply(m.id)} />
            ))
          )}
        </div>
        {reply && (
          <div className="reply-banner">
            {tr('正在回复 #{0}', reply)}
            <button className="text-button" onClick={() => setReply(undefined)}>
              {tr('取消')}
            </button>
          </div>
        )}
        <Composer destination={destination} replyTo={reply} onSent={() => setReply(undefined)} />
      </section>
    </div>
  );
}
export function MessageCard({ message, onReply }: { message: Message; onReply?: () => void }) {
  const tr = useI18n();
  return (
    <article className={`message-card kind-${message.kind}`}>
      <Avatar handle={message.author} />
      <div>
        <div className="event-meta">
          <strong>@{message.author}</strong>
          <span className={`tag kind-tag kind-${message.kind}`}>
            {tr(kindNames[message.kind] ?? message.kind)}
          </span>
          <time>{time(message.created_at)}</time>
        </div>
        {message.reply_to && <div className="reply-ref">{tr('回复 #{0}', message.reply_to)}</div>}
        <Markdown>{message.body}</Markdown>
        {onReply && (
          <button className="text-button small" onClick={onReply}>
            {tr('回复')}
          </button>
        )}
      </div>
    </article>
  );
}
export function Inbox() {
  const tr = useI18n();
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [pages, setPages] = useState<(number | undefined)[]>([undefined]);
  const [reply, setReply] = useState<Mention>();
  const inbox = useData<Mention[]>('check_inbox', {
    unread_only: unreadOnly,
    limit: 20,
    order: 'desc',
    before: pages.at(-1),
  });
  const action = useAction();
  const { openTask } = useBoard();
  const items = inbox.data ?? [];
  return (
    <section className="panel">
      <div className="panel-heading">
        <div className="segmented">
          <button
            className={unreadOnly ? 'active' : ''}
            onClick={() => {
              setUnreadOnly(true);
              setPages([undefined]);
            }}
          >
            {tr('未读')}
          </button>
          <button
            className={!unreadOnly ? 'active' : ''}
            onClick={() => {
              setUnreadOnly(false);
              setPages([undefined]);
            }}
          >
            {tr('全部')}
          </button>
        </div>
        <span className="muted">{tr('本页 {0} 条提及 · 最新在前', items.length)}</span>
      </div>
      <ErrorNotice error={inbox.error ?? action.error} />
      {items.length === 0 ? (
        <Empty title={tr('收件箱已清空')}>{tr('有人 @ 你时，消息会出现在这里。')}</Empty>
      ) : (
        items.map((mention) => (
          <div
            className={`inbox-item ${mention.message.kind === 'question' ? 'question' : ''}`}
            key={mention.id}
          >
            <MessageCard message={mention.message} />
            <div className="inbox-actions">
              {mention.message.task_id && (
                <button className="text-button" onClick={() => openTask(mention.message.task_id!)}>
                  T-{mention.message.task_id}
                  <ArrowUpRight size={13} />
                </button>
              )}
              <span className={`tag state-${mention.state}`}>
                {tr(mentionStateNames[mention.state] ?? mention.state)}
              </span>
              <button
                className="button subtle"
                onClick={() => setReply(reply?.id === mention.id ? undefined : mention)}
              >
                <MessageSquare size={14} />
                {tr('回复')}
              </button>
              {mention.state === 'unread' && (
                <button
                  className="button subtle"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ operation: 'mark_read', input: { ids: [mention.id] } })
                  }
                >
                  <Check size={14} />
                  {tr('已读')}
                </button>
              )}
              {mention.state !== 'resolved' && (
                <button
                  className="button subtle"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      operation: 'mark_read',
                      input: { ids: [mention.id], resolve: true },
                    })
                  }
                >
                  <CheckCheck size={14} />
                  {tr('已处理')}
                </button>
              )}
            </div>
            {reply?.id === mention.id && (
              <Composer
                destination={
                  mention.message.task_id
                    ? { task_id: mention.message.task_id }
                    : mention.message.channel_name?.startsWith('dm:')
                      ? { to: mention.message.author }
                      : { channel: mention.message.channel_name ?? 'general' }
                }
                replyTo={mention.message_id}
                onSent={() => setReply(undefined)}
              />
            )}
          </div>
        ))
      )}
      {(items.length === 20 || pages.length > 1) && (
        <div className="pagination">
          <button disabled={pages.length === 1} onClick={() => setPages(pages.slice(0, -1))}>
            {tr('上一页')}
          </button>
          <span>{tr('第 {0} 页', pages.length)}</span>
          <button
            disabled={items.length < 20}
            onClick={() => setPages([...pages, items.at(-1)!.id])}
          >
            {tr('下一页')}
          </button>
        </div>
      )}
    </section>
  );
}
