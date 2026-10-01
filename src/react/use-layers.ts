import { useMemo, useSyncExternalStore } from 'react';
import { getLayers } from '../commands/layers';
import type { LayerInfo } from '../commands/layers';
import type { DocumentEngine } from '../engine/create-document-engine';

const noLayers: LayerInfo[] = [];
const subscribeToNothing = (): (() => void) => () => undefined;
const nothing = (): LayerInfo[] => noLayers;

function sameLayers(first: readonly LayerInfo[], second: readonly LayerInfo[]): boolean {
  return (
    first.length === second.length &&
    first.every((layer, index) => {
      const other = second[index]!;
      return (
        layer.id === other.id &&
        layer.type === other.type &&
        layer.name === other.name &&
        layer.index === other.index &&
        layer.visible === other.visible &&
        layer.locked === other.locked
      );
    })
  );
}

function createLayerStore(engine: DocumentEngine): {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => LayerInfo[];
} {
  let snapshot = getLayers(engine);
  const refresh = (): boolean => {
    const next = getLayers(engine);
    if (sameLayers(next, snapshot)) return false;
    snapshot = next;
    return true;
  };
  return {
    subscribe(onChange) {
      const update = (): void => {
        if (refresh()) onChange();
      };
      const stops = [
        engine.on('history:change', update),
        engine.on('document:change', update),
        engine.on('load:success', update),
      ];
      engine.canvas.on('object:added', update);
      engine.canvas.on('object:removed', update);
      update();
      return () => {
        stops.forEach((stop) => stop());
        engine.canvas.off('object:added', update);
        engine.canvas.off('object:removed', update);
      };
    },
    getSnapshot: () => snapshot,
  };
}

/**
 * The layers of the canvas from top to bottom. It updates after every undo
 * step, load and add or remove. A change that is not recorded, such as
 * `object.set('visible', false)` alone, shows after `engine.commit()`.
 */
export function useLayers(engine: DocumentEngine | null | undefined): LayerInfo[] {
  const store = useMemo(() => (engine ? createLayerStore(engine) : null), [engine]);
  return useSyncExternalStore(store ? store.subscribe : subscribeToNothing, store ? store.getSnapshot : nothing, nothing);
}
