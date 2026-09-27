import { transitions, type TaskStatus } from '@baton/shared';

export const boardColumns: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: 'pending', label: '待开始', statuses: ['draft', 'open', 'claimed'] },
  { id: 'working', label: '执行中', statuses: ['in_progress', 'blocked', 'changes_requested'] },
  { id: 'review', label: '待验收', statuses: ['in_review'] },
  { id: 'finished', label: '已结束', statuses: ['done', 'cancelled'] },
];

export function dropTargets(status: TaskStatus, columnId: string): TaskStatus[] {
  const column = boardColumns.find((item) => item.id === columnId);
  return column
    ? transitions[status].filter((next) => next !== 'cancelled' && column.statuses.includes(next))
    : [];
}

export function taskFromHash(hash: string): number | undefined {
  const value = new URLSearchParams(hash.split('?')[1] ?? '').get('task');
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : undefined;
}

export const actionNames = {
  inspect_task: '查看任务',
  none: '无需后续操作',
  resolve_blocker: '处理阻塞',
  wait_for_approval: '处理审批',
  review: '继续独立验收',
  implement: '继续实现',
  dispatch_review: '安排独立验收',
  inspect_and_resume: '检查后恢复',
  dispatch_implement: '安排实现',
  complete_plan: '汇总计划结果',
  follow_children: '跟进子任务',
  request_approval: '准备审批',
};
