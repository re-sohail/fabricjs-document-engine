let fallbackCounter = 0;

export function createId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  fallbackCounter += 1;
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${randomPart}`;
}
