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
    const stack = createHistoryStack({ steps: 2, bytes: Infinity });
    ['one', 'two', 'three'].forEach((label) => stack.record(step(label)));
    expect(stack.undoLabels()).toEqual(['three', 'two']);
  });

  it('clears redo when a new step is recorded', () => {
    const stack = createHistoryStack({ steps: 10, bytes: Infinity });
    stack.record(step('one'));
    stack.returnRedo(stack.takeUndo()!);
    expect(stack.redoLabels()).toEqual(['one']);
    stack.record(step('two'));
    expect(stack.redoLabels()).toEqual([]);
  });
});

describe('history memory budget', () => {
  function stepWithPayload(label: string, characters: number): HistoryStep {
    return {
      label,
      before: { objects: new Map([['a', null]]), order: null },
      after: { objects: new Map([['a', 'x'.repeat(characters)]]), order: null },
    };
  }

  it('drops the oldest steps once the byte budget is used up', () => {
    const stack = createHistoryStack({ steps: 100, bytes: 5000 });
    ['one', 'two', 'three', 'four'].forEach((label) => stack.record(stepWithPayload(label, 1000)));
    expect(stack.undoLabels()).toEqual(['four', 'three']);
    expect(stack.usedBytes()).toBeLessThanOrEqual(5000);
  });

  it('always keeps the newest step even when it is larger than the budget', () => {
    const stack = createHistoryStack({ steps: 100, bytes: 100 });
    stack.record(stepWithPayload('huge', 10_000));
    expect(stack.undoLabels()).toEqual(['huge']);
  });

  it('keeps the byte count right while stepping back and forth', () => {
    const stack = createHistoryStack({ steps: 100, bytes: Infinity });
    stack.record(stepWithPayload('one', 100));
    stack.record(stepWithPayload('two', 100));
    const used = stack.usedBytes();
    stack.returnRedo(stack.takeUndo()!);
    stack.returnUndo(stack.takeRedo()!);
    expect(stack.usedBytes()).toBe(used);
    stack.clear();
    expect(stack.usedBytes()).toBe(0);
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
