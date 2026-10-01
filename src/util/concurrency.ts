/**
 * Runs `work` for every item with at most `limit` running at once, and
 * returns the results in the order of `items`.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  async function runWorker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}

/**
 * Lets the browser paint, handle input and run other queued work, such as a
 * framework's re-render after a progress update, before the next piece of
 * work. A message-channel task runs after the tasks already queued and,
 * unlike `setTimeout`, is not delayed by timer clamping. `scheduler.yield()`
 * is not used: it resumes ahead of other queued tasks, so a UI waiting to
 * show progress would not render until the work had finished.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
