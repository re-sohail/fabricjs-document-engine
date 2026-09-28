import type { FabricObject, StaticCanvas } from 'fabric';
import { DocumentEngineError } from '../engine/errors';
import type { ExportArea, ExportRect } from './export-options';

interface CanvasWithSelection {
  getActiveObjects?: () => FabricObject[];
}

function boundsOf(objects: readonly FabricObject[]): ExportRect | null {
  if (objects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const object of objects) {
    const box = object.getBoundingRect();
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

function padAndRound(rect: ExportRect, padding: number): ExportRect {
  const left = Math.floor(rect.left - padding);
  const top = Math.floor(rect.top - padding);
  return {
    left,
    top,
    width: Math.max(1, Math.ceil(rect.left + rect.width + padding) - left),
    height: Math.max(1, Math.ceil(rect.top + rect.height + padding) - top),
  };
}

export function resolveExportArea(canvas: StaticCanvas, area: ExportArea, padding: number): ExportRect {
  if (typeof area === 'object') return padAndRound(area, padding);
  if (area === 'canvas') return { left: 0, top: 0, width: canvas.getWidth(), height: canvas.getHeight() };

  const objects =
    area === 'selection' ? ((canvas as unknown as CanvasWithSelection).getActiveObjects?.() ?? []) : canvas.getObjects();
  const bounds = boundsOf(objects);
  if (bounds === null) {
    const reason = area === 'selection' ? 'nothing is selected' : 'the canvas is empty';
    throw new DocumentEngineError('INVALID_EXPORT_OPTIONS', `Cannot export the ${area} because ${reason}`);
  }
  return padAndRound(bounds, padding);
}
