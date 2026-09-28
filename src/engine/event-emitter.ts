export type Unsubscribe = () => void;

export interface EventEmitter<Events extends object> {
  on<Name extends keyof Events>(name: Name, handler: (payload: Events[Name]) => void): Unsubscribe;
  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void;
  clear(): void;
}

export function createEventEmitter<Events extends object>(): EventEmitter<Events> {
  const handlersByName = new Map<keyof Events, Set<(payload: never) => void>>();

  return {
    on(name, handler) {
      const handlers = handlersByName.get(name) ?? new Set();
      handlers.add(handler);
      handlersByName.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(name, payload) {
      const handlers = handlersByName.get(name);
      if (!handlers) return;
      for (const handler of [...handlers]) (handler as (value: typeof payload) => void)(payload);
    },
    clear() {
      handlersByName.clear();
    },
  };
}
