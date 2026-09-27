import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { Task } from '@baton/shared';
import { useI18n } from './i18n.js';
import { ErrorNotice, useAction } from './board.js';
import { Markdown } from './Markdown.js';

export function InlineTaskText({
  task,
  field,
  disabled,
}: {
  task: Task;
  field: 'title' | 'description';
  disabled: boolean;
}) {
  const tr = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task[field]);
  const action = useAction();
  const label = field === 'title' ? tr('任务名称') : tr('任务描述');
  if (editing)
    return (
      <form
        className="inline-edit form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await action.mutateAsync({
              operation: 'update_task',
              input: { id: task.id, [field]: value },
            });
            setEditing(false);
          } catch {
            /* Preserve edits and display the server error. */
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!action.isPending) setEditing(false);
          }
        }}
      >
        {field === 'title' ? (
          <input
            aria-label={label}
            value={value}
            maxLength={240}
            required
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <textarea
            aria-label={label}
            value={value}
            maxLength={20000}
            rows={6}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <ErrorNotice error={action.error} />
        <div className="inline">
          <button
            className="button primary"
            disabled={action.isPending || (field === 'title' && !value.trim())}
          >
            {tr('保存')}
          </button>
          <button
            type="button"
            className="button"
            disabled={action.isPending}
            onClick={() => setEditing(false)}
          >
            {tr('取消')}
          </button>
        </div>
      </form>
    );
  return (
    <div className={`editable-text editable-${field}`}>
      {field === 'title' ? (
        <h1>{task.title}</h1>
      ) : (
        <Markdown>{task.description || tr('暂无描述')}</Markdown>
      )}
      {!disabled && (
        <button
          className="icon-button"
          aria-label={tr('编辑{0}', label)}
          onClick={() => {
            setValue(task[field]);
            action.reset();
            setEditing(true);
          }}
        >
          <Pencil size={15} />
        </button>
      )}
    </div>
  );
}
