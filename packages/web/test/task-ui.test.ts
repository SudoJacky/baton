import { expect, it } from 'vitest';
import { boardColumns, dropTargets, taskFromHash } from '../src/task-ui.js';

it('keeps precise statuses while requiring an explicit choice for ambiguous stage drops', () => {
  expect(boardColumns.find((column) => column.id === 'working')?.statuses).toEqual([
    'in_progress',
    'blocked',
    'changes_requested',
  ]);
  expect(dropTargets('claimed', 'working')).toEqual(['in_progress', 'blocked']);
  expect(dropTargets('open', 'working')).toEqual([]);
  expect(dropTargets('in_progress', 'finished')).toEqual([]);
  expect(dropTargets('in_review', 'finished')).toEqual(['done']);
  expect(dropTargets('done', 'pending')).toEqual([]);
  expect(dropTargets('cancelled', 'pending')).toEqual([]);
});
it('restores task links and rejects malformed identifiers', () => {
  expect(taskFromHash('#board?task=42')).toBe(42);
  expect(taskFromHash('#overview?task=42')).toBe(42);
  for (const hash of [
    '#board',
    '#board?task=0',
    '#board?task=-1',
    '#board?task=abc',
    '#board?task=9007199254740993',
  ])
    expect(taskFromHash(hash)).toBeUndefined();
});
