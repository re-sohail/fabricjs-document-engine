import { useEffect, useRef } from 'react';
import type { DocumentEngine, DocumentEngineEvents } from '../engine/create-document-engine';

export function useDocumentEvent<Name extends keyof DocumentEngineEvents>(
  engine: DocumentEngine | null | undefined,
  name: Name,
  handler: (payload: DocumentEngineEvents[Name]) => void,
): void {
  const latestHandler = useRef(handler);
  latestHandler.current = handler;

  useEffect(() => {
    if (!engine) return undefined;
    return engine.on(name, (payload) => latestHandler.current(payload));
  }, [engine, name]);
}
