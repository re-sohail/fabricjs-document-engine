import { describe, expect, it, vi } from 'vitest';
import { createId } from '../src/document/ids';
import { createEventEmitter } from '../src/engine/event-emitter';
import { collectSerializedTypes } from '../src/fabric/walk-objects';

describe('createId', () => {
  it('creates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, createId));
    expect(ids.size).toBe(1000);
  });
});

describe('createEventEmitter', () => {
  it('delivers events until the handler unsubscribes', () => {
    const emitter = createEventEmitter<{ saved: number }>();
    const handler = vi.fn();
    const unsubscribe = emitter.on('saved', handler);
    emitter.emit('saved', 1);
    unsubscribe();
    emitter.emit('saved', 2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });
});

describe('collectSerializedTypes', () => {
  it('finds types inside groups and clip paths', () => {
    const types = collectSerializedTypes([
      { type: 'Group', objects: [{ type: 'Sticker' }, { type: 'Group', objects: [{ type: 'Circle' }] }] },
      { type: 'Rect', clipPath: { type: 'Ellipse' } },
    ]);
    expect([...types].sort()).toEqual(['Circle', 'Ellipse', 'Group', 'Rect', 'Sticker']);
  });
});
