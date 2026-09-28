import { describe, expect, it } from 'vitest';
import { createSnapshot, diffSnapshots } from '../src/history/snapshot';
import { createHistoryStack } from '../src/history/history-stack';
import type { HistoryStep } from '../src/history/history-stack';
import { describePendingChanges } from '../src/history/create-history';

const rect = (id: string, fill = 'red') => ({ type: 'Rect', id, fill });

function step(label: string): HistoryStep {
  const empty = { objects: new Map(), order: null };
  return { label, before: empty, after: empty };
}

describe('diffSnapshots', () => {
  it('returns nothing when nothing changed', () => {
    const snapshot = createSnapshot([rect('a'), rect('b')]);
    expect(diffSnapshots(snapshot, createSnapshot([rect('a'), rect('b')]))).toBeNull();
  });

  it('keeps only the objects that changed', () => {
    const difference = diffSnapshots(createSnapshot([rect('a'), rect('b')]), createSnapshot([rect('a'), rect('b', 'blue')]));
    expect([...difference!.after.objects.keys()]).toEqual(['b']);
    expect(difference!.after.order).toBeNull();
  });

  it('records additions and deletions as null on the missing side', () => {
    const difference = diffSnapshots(createSnapshot([rect('a')]), createSnapshot([rect('b')]));
    expect(difference!.before.objects.get('b')).toBeNull();
    expect(difference!.after.objects.get('a')).toBeNull();
    expect(difference!.before.order).toEqual(['a']);
    expect(difference!.after.order).toEqual(['b']);
  });

  it('notices a change of order alone', () => {
    const difference = diffSnapshots(createSnapshot([rect('a'), rect('b')]), createSnapshot([rect('b'), rect('a')]));
    expect(difference!.after.objects.size).toBe(0);
    expect(difference!.after.order).toEqual(['b', 'a']);
  });
});

describe('createHistoryStack', () => {
  it('drops the oldest step when the limit is reached', () => {
    const stack = createHistoryStack(2);
    ['one', 'two', 'three'].forEach((label) => stack.record(step(label)));
    expect(stack.undoLabels()).toEqual(['three', 'two']);
  });

  it('clears redo when a new step is recorded', () => {
    const stack = createHistoryStack(10);
    stack.record(step('one'));
    stack.returnRedo(stack.takeUndo()!);
    expect(stack.redoLabels()).toEqual(['one']);
    stack.record(step('two'));
    expect(stack.redoLabels()).toEqual([]);
  });
});

describe('describePendingChanges', () => {
  it('names one change after its object', () => {
    expect(describePendingChanges([{ verb: 'Move', noun: 'rect' }])).toBe('Move rect');
  });

  it('counts several changes of the same kind', () => {
    const changes = [
      { verb: 'Delete', noun: 'rect' },
      { verb: 'Delete', noun: 'circle' },
    ];
    expect(describePendingChanges(changes)).toBe('Delete 2 objects');
  });

  it('falls back to a general label for mixed changes', () => {
    const changes = [
      { verb: 'Delete', noun: 'rect' },
      { verb: 'Add', noun: 'group' },
    ];
    expect(describePendingChanges(changes)).toBe('Edit objects');
  });
});
