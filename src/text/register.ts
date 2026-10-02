import { classRegistry } from 'fabric';
import type { CustomObjectDefinition } from '../fabric/object-registry';
import { BoundedTextbox } from './bounded-textbox';
import { ShapedIText, ShapedTextbox } from './shaping';
import { VerticalText } from './vertical-text';

export const textObjects: CustomObjectDefinition[] = [
  { fabricClass: BoundedTextbox },
  { fabricClass: ShapedIText },
  { fabricClass: ShapedTextbox },
  { fabricClass: VerticalText },
];

export function registerTextObjects(): void {
  for (const { fabricClass } of textObjects) classRegistry.setClass(fabricClass as never);
}
