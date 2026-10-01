import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fabric from 'fabric';
import { Canvas, Rect } from 'fabric';
import { StrictMode, act, createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { bringToFront, createDocumentEngine, createDocumentStateStore } from '../src';
import type { DocumentEngine, DocumentState } from '../src';
import {
  DocumentEngineProvider,
  useDocumentEngine,
  useDocumentEvent,
  useDocumentState,
  useEngine,
  useLayers,
} from '../src/react';
import type { ReactEngineOptions } from '../src/react';
import { createMemoryStorage } from '../src/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const canvases: Canvas[] = [];

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(StrictMode, null, element)));
  return container;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Captured {
  engine: DocumentEngine | null;
  state: DocumentState | null;
  engines: DocumentEngine[];
}

function Editor({ options, captured }: { options: ReactEngineOptions; captured: Captured }): ReactNode {
  const elementRef = useRef<HTMLCanvasElement>(null);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  useEffect(() => {
    const created = new Canvas(elementRef.current!, { width: 200, height: 100 });
    canvases.push(created);
    setCanvas(created);
    return () => {
      created.dispose().catch(() => undefined);
    };
  }, []);
  const engine = useDocumentEngine(canvas, options);
  const state = useDocumentState(engine);
  captured.engine = engine;
  captured.state = state;
  if (engine && !captured.engines.includes(engine)) captured.engines.push(engine);

  return createElement(
    'div',
    null,
    createElement('canvas', { ref: elementRef }),
    createElement(
      DocumentEngineProvider,
      { engine },
      createElement(Toolbar),
    ),
  );
}

function Toolbar(): ReactNode {
  const engine = useEngine();
  const state = useDocumentState(engine);
  return createElement(
    'div',
    null,
    createElement('button', { 'data-action': 'undo', disabled: !state?.canUndo, onClick: () => void engine?.undo() }, `Undo ${state?.undoLabel ?? ''}`),
    createElement('span', { 'data-role': 'status' }, state?.saveStatus ?? 'none'),
  );
}

afterEach(async () => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  await Promise.all(canvases.splice(0).map((canvas) => canvas.dispose().catch(() => undefined)));
  document.body.innerHTML = '';
});

describe(`react adapter on Fabric ${fabric.version}`, () => {
  it('creates one live engine in strict mode and destroys the extra ones', async () => {
    const captured: Captured = { engine: null, state: null, engines: [] };
    mount(createElement(Editor, { options: {}, captured }));
    await act(nextTick);
    const live = captured.engine!;
    expect(live).not.toBeNull();
    expect(() => live.toDocument()).not.toThrow();
    const destroyed = captured.engines.filter((engine) => engine !== live);
    destroyed.forEach((engine) => expect(() => engine.toDocument()).toThrow(/destroyed/));
  });

  it('keeps toolbar state in step with the engine', async () => {
    const captured: Captured = { engine: null, state: null, engines: [] };
    const container = mount(createElement(Editor, { options: { storage: createMemoryStorage() }, captured }));
    await act(nextTick);
    const undoButton = container.querySelector<HTMLButtonElement>('[data-action="undo"]')!;
    expect(undoButton.disabled).toBe(true);
    expect(captured.state).toMatchObject({ isDirty: false, canUndo: false, saveStatus: 'saved' });

    await act(async () => {
      captured.engine!.canvas.add(new Rect({ width: 10, height: 10 }));
      await nextTick();
    });
    expect(undoButton.disabled).toBe(false);
    expect(undoButton.textContent).toBe('Undo Add rect');
    expect(captured.state).toMatchObject({ isDirty: true, canUndo: true, saveStatus: 'unsaved' });

    await act(async () => {
      await captured.engine!.save();
    });
    expect(container.querySelector('[data-role="status"]')!.textContent).toBe('saved');

    await act(async () => {
      undoButton.click();
      await nextTick();
    });
    expect(captured.state).toMatchObject({ canUndo: false, canRedo: true, isDirty: true });
  });

  it('reports load errors and loading state', async () => {
    const captured: Captured = { engine: null, state: null, engines: [] };
    mount(createElement(Editor, { options: {}, captured }));
    await act(nextTick);
    await act(async () => {
      await captured.engine!.loadDocument({ nonsense: true }).catch(() => undefined);
    });
    expect(captured.state).toMatchObject({ isLoading: false, loadError: expect.objectContaining({ code: 'INVALID_DOCUMENT' }) });

    const valid = captured.engine!.toDocument();
    await act(async () => {
      await captured.engine!.loadDocument({ ...valid, id: 'loaded-in-react' });
    });
    expect(captured.state).toMatchObject({ documentId: 'loaded-in-react', loadError: undefined, isLoading: false });
  });

  it('calls the latest event handler', async () => {
    const seen: string[] = [];
    function Listener({ engine, prefix }: { engine: DocumentEngine | null; prefix: string }): ReactNode {
      useDocumentEvent(engine, 'history:change', (state) => seen.push(`${prefix}:${state.undoLabel}`));
      return null;
    }
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element);
    canvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(Listener, { engine, prefix: 'first' })));
    act(() => root.render(createElement(Listener, { engine, prefix: 'second' })));
    await act(async () => {
      canvas.add(new Rect({ width: 5, height: 5 }));
      await nextTick();
    });
    expect(seen).toEqual(['second:Add rect']);
    engine.destroy();
  });
});

describe(`engine lifecycle on Fabric ${fabric.version}`, () => {
  function countCanvasListeners(canvas: Canvas): number {
    const listeners = (canvas as unknown as { __eventListeners?: Record<string, unknown[]> }).__eventListeners ?? {};
    return Object.values(listeners).reduce((total, handlers) => total + handlers.length, 0);
  }

  it('leaves no canvas listeners behind after destroy', () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element);
    canvases.push(canvas);
    const baseline = countCanvasListeners(canvas);
    for (let round = 0; round < 30; round += 1) {
      const engine = createDocumentEngine({ canvas, storage: createMemoryStorage(), autosave: true });
      engine.destroy();
    }
    expect(countCanvasListeners(canvas)).toBe(baseline);
  });

  it('gives a stable snapshot until something changes', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element);
    canvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    const store = createDocumentStateStore(engine);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    canvas.add(new Rect({ width: 5, height: 5 }));
    await nextTick();
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
    unsubscribe();
    engine.destroy();
  });
});

describe(`useLayers on Fabric ${fabric.version}`, () => {
  function LayerList({ engine }: { engine: DocumentEngine }): ReactNode {
    const layers = useLayers(engine);
    return createElement(
      'ul',
      null,
      layers.map((layer) => createElement('li', { key: layer.id }, layer.name ?? layer.type)),
    );
  }

  it('lists layers top first and follows adds, reorders, undo and removes', async () => {
    const element = document.createElement('canvas');
    document.body.append(element);
    const canvas = new Canvas(element, { width: 100, height: 100 });
    canvases.push(canvas);
    const engine = createDocumentEngine({ canvas });
    const names = (): string[] => [...container.querySelectorAll('li')].map((item) => item.textContent ?? '');
    const container = mount(createElement(LayerList, { engine }));
    expect(names()).toEqual([]);

    const shapes = ['back', 'middle', 'front'].map((name) => {
      const shape = new Rect({ width: 5, height: 5 });
      (shape as unknown as { name: string }).name = name;
      return shape;
    });
    await act(async () => {
      canvas.add(...shapes);
      await nextTick();
    });
    expect(names()).toEqual(['front', 'middle', 'back']);

    await act(async () => {
      bringToFront(engine, [shapes[0]!]);
      await nextTick();
    });
    expect(names()).toEqual(['back', 'front', 'middle']);

    await act(async () => {
      await engine.undo();
    });
    expect(names()).toEqual(['front', 'middle', 'back']);

    await act(async () => {
      canvas.remove(engine.canvas.getObjects()[2]!);
      await nextTick();
    });
    expect(names()).toEqual(['middle', 'back']);
    engine.destroy();
  });
});
