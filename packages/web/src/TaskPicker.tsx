import { useEffect, useId, useRef, useState } from 'react';
import type { Task, TaskSummary } from '@baton/shared';
import { Search, X } from 'lucide-react';
import { useI18n } from './i18n.js';
import { Badge, ErrorNotice, useBoard, useData } from './board.js';

export function TaskReference({
  id,
  onRemove,
  previewOnly = false,
}: {
  id: number;
  onRemove?: () => void;
  previewOnly?: boolean;
}) {
  const tr = useI18n();
  const { openTask } = useBoard();
  const task = useData<Task>('get_task', { id });
  const content = (
    <>
      <span className="mono">T-{id}</span>
      <span>{task.data?.title ?? tr('正在读取任务…')}</span>
      {task.data && <Badge status={task.data.status} />}
      {task.data?.assignee && <span className="muted small">@{task.data.assignee}</span>}
    </>
  );
  return (
    <div className="task-reference">
      {previewOnly ? (
        <div className="task-reference-link">{content}</div>
      ) : (
        <button type="button" className="task-reference-link" onClick={() => openTask(id)}>
          {content}
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="icon-button"
          aria-label={tr('移除 T-{0}', id)}
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      )}
      <ErrorNotice error={task.error} />
    </div>
  );
}

export function TaskPicker({
  label,
  value,
  onChange,
  exclude = [],
  single = false,
  plansOnly = false,
  disabled = false,
}: {
  label: string;
  value: number[];
  onChange: (value: number[]) => void;
  exclude?: number[];
  single?: boolean;
  plansOnly?: boolean;
  disabled?: boolean;
}) {
  const tr = useI18n();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(0);
      setSelected(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useData<TaskSummary[]>(
    'list_tasks',
    {
      search: query || undefined,
      type: plansOnly ? 'plan' : undefined,
      limit: 20,
      offset: page * 20,
    },
    open && !disabled,
  );
  const searching = results.isFetching || search !== query;
  const items = (searching ? [] : (results.data ?? [])).filter(
    (task) => !exclude.includes(task.id) && !value.includes(task.id),
  );
  const pick = (task: TaskSummary) => {
    onChange(single ? [task.id] : [...value, task.id]);
    setSearch('');
    setOpen(false);
    setSelected(0);
  };
  const highlighted = Math.min(selected, Math.max(0, items.length - 1));
  return (
    <div
      className="task-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={`${listId}-input`}>{label}</label>
      <div className="task-picker-input">
        <Search size={15} aria-hidden="true" />
        <input
          id={`${listId}-input`}
          ref={input}
          value={search}
          disabled={disabled}
          autoComplete="off"
          placeholder={tr('搜索任务标题或编号')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && items[highlighted] ? `${listId}-${items[highlighted]!.id}` : undefined
          }
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setSearch(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setSelected(
                Math.max(
                  0,
                  Math.min(items.length - 1, highlighted + (event.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            }
            if (event.key === 'Enter' && open) {
              event.preventDefault();
              if (items[highlighted]) pick(items[highlighted]!);
            }
          }}
        />
      </div>
      {open && (
        <div className="task-picker-results">
          <ErrorNotice error={results.error} />
          <div role="listbox" id={listId} aria-label={label}>
            {items.map((task, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${task.id}`}
                key={task.id}
                aria-selected={index === highlighted}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(task)}
              >
                <span className="mono">T-{task.id}</span>
                <span>{task.title}</span>
                <Badge status={task.status} />
                {task.assignee && <span className="small muted">@{task.assignee}</span>}
              </button>
            ))}
          </div>
          {!items.length && (
            <p className="muted small">{searching ? tr('正在搜索…') : tr('没有匹配的任务')}</p>
          )}
          {(page > 0 || results.data?.length === 20) && (
            <div className="pagination">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => {
                  setPage(page - 1);
                  setSelected(0);
                  input.current?.focus();
                }}
              >
                {tr('上一页')}
              </button>
              <button
                type="button"
                disabled={results.data?.length !== 20}
                onClick={() => {
                  setPage(page + 1);
                  setSelected(0);
                  input.current?.focus();
                }}
              >
                {tr('下一页')}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="task-picker-selected">
        {value.map((id) => (
          <TaskReference
            key={id}
            id={id}
            previewOnly
            onRemove={disabled ? undefined : () => onChange(value.filter((other) => other !== id))}
          />
        ))}
      </div>
    </div>
  );
}
