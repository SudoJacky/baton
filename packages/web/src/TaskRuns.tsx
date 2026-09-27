import { useState } from 'react';
import type { TaskRun } from '@baton/shared';
import { useI18n } from './i18n.js';
import { Empty, ErrorNotice, time, useData } from './board.js';
import { Markdown } from './Markdown.js';

const runStates = {
  active: '已派发',
  completed: '本轮结束',
  stopped: '派发已停止',
  expired: '派发已过期',
};
const outcomes = { submitted: '已提交验收', approve: '验收通过', changes_requested: '请求修改' };
export function TaskRuns({ id }: { id: number }) {
  const tr = useI18n();
  const [page, setPage] = useState(0);
  const runs = useData<{ items: TaskRun[]; total: number }>('list_task_runs', {
    id,
    limit: 10,
    offset: page * 10,
  });
  return (
    <section className="task-runs" aria-label={tr('执行与证据')}>
      <ErrorNotice error={runs.error} />
      {!runs.data && !runs.error && <p className="muted">{tr('正在读取执行记录…')}</p>}
      {runs.data?.total === 0 && (
        <Empty title={tr('尚无派发记录')}>{tr('手动操作与旧任务记录可在讨论记录中查看。')}</Empty>
      )}
      {runs.data?.items.map((run, index) => (
        <article className="run-card" key={run.run_id}>
          <header className="run-heading">
            <strong>
              {tr(
                '第 {0} 轮 · {1}',
                runs.data!.total - page * 10 - index,
                run.mode === 'review' ? tr('独立验收') : tr('实现'),
              )}
            </strong>
            <span
              className={`tag ${run.outcome === 'changes_requested' || ['stopped', 'expired'].includes(run.state) ? 'danger' : ''}`}
            >
              {tr(run.outcome ? outcomes[run.outcome] : runStates[run.state])}
            </span>
          </header>
          <div className="run-meta">
            <span>@{run.handle}</span>
            <time dateTime={run.created_at}>{time(run.created_at)}</time>
            {run.ended_at && <span>{tr('结束于 {0}', time(run.ended_at))}</span>}
          </div>
          {run.state === 'active' && (
            <p className="muted small">{tr('派发有效；实际执行状态由宿主确认。')}</p>
          )}
          {run.mode === 'review' && run.state === 'completed' && !run.outcome && (
            <p className="muted small">{tr('历史记录未保存验收结论，请核对讨论记录。')}</p>
          )}
          {run.summary && <Markdown>{run.summary}</Markdown>}
          <dl className="run-version">
            <dt>{tr(run.mode === 'review' ? '验收版本' : '本轮提交')}</dt>
            <dd>
              <code>
                {(run.mode === 'review' ? run.commit_sha : run.submitted_commit_sha) ??
                  tr('未记录')}
              </code>
            </dd>
          </dl>
          <div className="run-evidence">
            <h3>
              {tr('检查证据')} <span className="muted">{run.evidence.length}</span>
            </h3>
            {!run.evidence.length && <p className="muted small">{tr('本轮没有附加检查证据。')}</p>}
            {run.evidence.map((evidence) => (
              <details className="evidence-item" key={`${evidence.path}-${evidence.sha256}`}>
                <summary>
                  <span>{evidence.scope}</span>
                  <span
                    className={
                      evidence.exit_code === 0
                        ? 'evidence-pass'
                        : evidence.exit_code === undefined
                          ? 'muted'
                          : 'danger'
                    }
                  >
                    {evidence.exit_code === undefined
                      ? tr('证据文件')
                      : tr('退出码 {0}', evidence.exit_code)}
                  </span>
                </summary>
                <dl>
                  {evidence.command && (
                    <>
                      <dt>{tr('检查命令')}</dt>
                      <dd>
                        <code>
                          {evidence.command
                            .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
                            .join(' ')}
                        </code>
                      </dd>
                    </>
                  )}
                  <dt>{tr('文件路径')}</dt>
                  <dd>
                    <code>{evidence.path}</code>
                  </dd>
                  <dt>{tr('证据版本')}</dt>
                  <dd>
                    <code>{evidence.commit_sha ?? tr('未记录')}</code>
                  </dd>
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{evidence.sha256}</code>
                  </dd>
                  <dt>{tr('记录时间')}</dt>
                  <dd>
                    {time(evidence.recorded_at)} · {evidence.size_bytes.toLocaleString()} B
                  </dd>
                </dl>
              </details>
            ))}
          </div>
          <details className="run-identifiers">
            <summary>{tr('交接标识')}</summary>
            <code>{run.run_id}</code>
            <p className="muted small">{tr('协调者 @{0}', run.coordinator)}</p>
          </details>
        </article>
      ))}
      {(page > 0 || (runs.data?.total ?? 0) > 10) && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            {tr('较新的轮次')}
          </button>
          <button
            disabled={(page + 1) * 10 >= (runs.data?.total ?? 0)}
            onClick={() => setPage(page + 1)}
          >
            {tr('更早的轮次')}
          </button>
        </div>
      )}
    </section>
  );
}
