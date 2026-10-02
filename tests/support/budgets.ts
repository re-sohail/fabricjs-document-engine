import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    budgetScale: number;
    checkBudgets: boolean;
  }
}

export const checkBudgets: boolean = inject('checkBudgets');

export function budget(ms: number): number {
  return ms * inject('budgetScale');
}
