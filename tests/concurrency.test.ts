import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, yieldToEventLoop } from '../src/util/concurrency';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('keeps the order of the items', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms, index) => {
      await wait(ms);
      return index;
    });
    expect(results).toEqual([0, 1, 2]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let mostAtOnce = 0;
    await mapWithConcurrency(Array.from({ length: 9 }), 3, async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await wait(5);
      running -= 1;
    });
    expect(mostAtOnce).toBe(3);
  });

  it('treats a limit below one as one', async () => {
    let running = 0;
    let mostAtOnce = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await wait(1);
      running -= 1;
    });
    expect(mostAtOnce).toBe(1);
  });

  it('returns an empty list for no items', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('rejects when one item fails', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('yieldToEventLoop', () => {
  it('lets a message queued earlier run first', async () => {
    const order: string[] = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      order.push('queued');
    };
    channel.port2.postMessage(undefined);
    await yieldToEventLoop();
    order.push('after');
    expect(order).toEqual(['queued', 'after']);
  });

  it('lets a timer that is already due run first', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await wait(1);
    await yieldToEventLoop();
    order.push('after');
    expect(order).toEqual(['timer', 'after']);
  });
});
