import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { DocumentEngine } from '../engine/create-document-engine';

const EngineContext = createContext<DocumentEngine | null>(null);

export interface DocumentEngineProviderProps {
  engine: DocumentEngine | null;
  children?: ReactNode;
}

export function DocumentEngineProvider({ engine, children }: DocumentEngineProviderProps): ReactNode {
  return createElement(EngineContext.Provider, { value: engine }, children);
}

export function useEngine(): DocumentEngine | null {
  return useContext(EngineContext);
}
