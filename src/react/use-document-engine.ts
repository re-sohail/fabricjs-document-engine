import { useEffect, useRef, useState } from 'react';
import type { StaticCanvas } from 'fabric';
import { createDocumentEngine } from '../engine/create-document-engine';
import type { DocumentEngine, DocumentEngineOptions } from '../engine/create-document-engine';

export type ReactEngineOptions = Omit<DocumentEngineOptions, 'canvas'>;

export function useDocumentEngine(
  canvas: StaticCanvas | null | undefined,
  options: ReactEngineOptions = {},
): DocumentEngine | null {
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [engine, setEngine] = useState<DocumentEngine | null>(null);

  useEffect(() => {
    if (!canvas) return undefined;
    const created = createDocumentEngine({ ...latestOptions.current, canvas });
    setEngine(created);
    return () => {
      created.destroy();
      setEngine((current) => (current === created ? null : current));
    };
  }, [canvas]);

  return engine;
}
