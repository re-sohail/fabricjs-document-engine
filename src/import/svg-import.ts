import { FixedLayout, Group, LayoutManager, Rect, parseSVGDocument, util } from 'fabric';
import type { FabricObject } from 'fabric';
import { DocumentEngineError, isDocumentEngineError } from '../engine/errors';
import { isSafeImageUrl } from '../security/content-limits';
import type { ContentLimits } from '../security/content-limits';

/**
 * Opens SVG files as Fabric objects without moving them (fabric.js #10916).
 *
 * Fabric's parser already puts every element where the SVG's viewBox says.
 * The usual next step, `util.groupSVGElements`, then sizes the group to the
 * content, so an element outside the viewBox, or a hidden one, moves and
 * resizes everything. This keeps the SVG's own viewport as the frame instead.
 */

export interface SvgImportOptions {
  /**
   * `preserve` (the default) keeps the SVG's viewport, so the artwork lands
   * where it sits in the file. `content` uses the bounds of what is drawn,
   * like `util.groupSVGElements`.
   */
  viewport?: 'preserve' | 'content';
  /** What to do with elements entirely outside the viewport: keep them, drop them, or clip them. Default `keep`. */
  offscreen?: 'keep' | 'drop' | 'clip';
  /** One group (the default), or separate objects. */
  as?: 'group' | 'objects';
  preserveGroups?: boolean;
  /** Where the viewport's top-left corner lands on the canvas. Default 0, 0. */
  left?: number;
  top?: number;
  /** Scales the viewport into this box. `contain` keeps the whole SVG visible, `cover` fills the box, `fill` stretches. */
  fit?: { width: number; height: number; mode?: 'contain' | 'cover' | 'fill' };
  /** Passed to images in the SVG. Default `anonymous`, so the canvas can still be exported. */
  crossOrigin?: 'anonymous' | 'use-credentials' | null;
  signal?: AbortSignal;
}

export type SvgImportWarningCode = 'SVG_CONTENT_REMOVED' | 'SVG_IMAGE_BLOCKED' | 'SVG_OFFSCREEN_DROPPED';

export interface SvgImportWarning {
  code: SvgImportWarningCode;
  message: string;
}

export interface SvgImportResult {
  /** The objects added to the canvas: one group, or each object. */
  objects: FabricObject[];
  /** The size of the SVG's viewport in canvas units, before `fit`. */
  viewport: { width: number; height: number };
  warnings: SvgImportWarning[];
}

const XLINK = 'http://www.w3.org/1999/xlink';
const REMOVED_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'set', 'animateTransform', 'animateMotion'];

function refuse(message: string, cause?: unknown): never {
  throw new DocumentEngineError('SVG_IMPORT_FAILED', message, cause === undefined ? {} : { cause });
}

function unsafe(message: string): never {
  throw new DocumentEngineError('UNSAFE_DOCUMENT', `The SVG was refused: ${message}`, {
    issues: [{ code: 'UNSAFE_DOCUMENT', path: '', message }],
  });
}

function parse(svg: string): Document {
  if (typeof DOMParser === 'undefined') refuse('Importing SVG needs a browser DOM');
  const document = new DOMParser().parseFromString(svg.trim(), 'image/svg+xml');
  const error = document.querySelector('parsererror');
  if (error) refuse(`The SVG is not valid XML: ${(error.textContent ?? '').trim().slice(0, 200)}`);
  if (document.documentElement.localName !== 'svg') refuse('The file is not an SVG: its root element is not <svg>');
  return document;
}

function depthOf(element: Element): number {
  let deepest = 0;
  const pending: Array<[Element, number]> = [[element, 1]];
  while (pending.length > 0) {
    const [current, depth] = pending.pop()!;
    deepest = Math.max(deepest, depth);
    for (const child of Array.from(current.children)) pending.push([child, depth + 1]);
  }
  return deepest;
}

/**
 * Removes what an SVG can use to run code or reach other servers. Fabric
 * never runs scripts, but the same file may be shown elsewhere later.
 */
function sanitize(document: Document, limits: ContentLimits, warnings: SvgImportWarning[]): void {
  const root = document.documentElement;
  const elements = root.getElementsByTagName('*').length;
  const maxObjects = limits.maxObjects ?? 50_000;
  if (elements > maxObjects) unsafe(`it has ${elements} elements, the limit is ${maxObjects}`);
  const maxDepth = limits.maxDepth ?? 100;
  const depth = depthOf(root);
  if (depth > maxDepth) unsafe(`it is nested ${depth} levels deep, the limit is ${maxDepth}`);

  let removed = 0;
  for (const name of REMOVED_ELEMENTS) {
    for (const element of Array.from(root.getElementsByTagName(name))) {
      element.remove();
      removed += 1;
    }
  }
  const isAllowed = limits.isAllowedUrl ?? isSafeImageUrl;
  for (const element of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
        removed += 1;
      }
    }
    const link = element.getAttribute('href') ?? element.getAttributeNS(XLINK, 'href');
    if (link === null) continue;
    const target = link.trim();
    if (element.localName === 'image') {
      if (!isAllowed(target) || /^javascript:/i.test(target)) {
        warnings.push({ code: 'SVG_IMAGE_BLOCKED', message: `An image with the address ${target.slice(0, 80)} was left out because the address is not allowed` });
        element.remove();
      }
    } else if (!target.startsWith('#')) {
      // Links to other files (<use href="other.svg#icon">) and links that run code.
      element.removeAttribute('href');
      element.removeAttributeNS(XLINK, 'href');
      removed += 1;
    }
  }
  for (const style of Array.from(root.getElementsByTagName('style'))) {
    const css = style.textContent ?? '';
    const cleaned = css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
    if (cleaned !== css) {
      style.textContent = cleaned;
      removed += 1;
    }
  }
  if (removed > 0) {
    warnings.push({
      code: 'SVG_CONTENT_REMOVED',
      message: `${removed} scripts, event handlers, embedded pages or links to other files were removed from the SVG`,
    });
  }
}

function intersectsViewport(object: FabricObject, width: number, height: number): boolean {
  object.setCoords();
  const box = object.getBoundingRect();
  return box.left < width && box.top < height && box.left + box.width > 0 && box.top + box.height > 0;
}

function contentBounds(objects: readonly FabricObject[]): { left: number; top: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const object of objects) {
    object.setCoords();
    const box = object.getBoundingRect();
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  return Number.isFinite(left) ? { left, top, width: right - left, height: bottom - top } : { left: 0, top: 0, width: 0, height: 0 };
}

function dropBrokenUses(document: Document): void {
  for (const use of Array.from(document.getElementsByTagName('use'))) {
    const link = (use.getAttribute('href') ?? use.getAttributeNS(XLINK, 'href') ?? '').trim();
    if (!link.startsWith('#') || link.length === 1 || document.getElementById(link.slice(1)) === null) use.remove();
  }
}

const GROUP_MARK = 'data-fde-svg-group';
function markGroups(document: Document): void {
  for (const name of ['g', 'a']) {
    for (const element of Array.from(document.documentElement.getElementsByTagName(name))) element.setAttribute(GROUP_MARK, '');
  }
}
function svgMetadata(element: Element): { svgId?: string; svgClass?: string; svgData?: Record<string, string> } {
  const metadata: { svgId?: string; svgClass?: string; svgData?: Record<string, string> } = {};
  const id = element.getAttribute('id');
  if (id) metadata.svgId = id;
  const className = element.getAttribute('class');
  if (className) metadata.svgClass = className;
  for (const attribute of Array.from(element.attributes)) {
    if (!attribute.name.startsWith('data-') || attribute.name === GROUP_MARK) continue;
    (metadata.svgData ??= {})[attribute.name.slice(5)] = attribute.value;
  }
  return metadata;
}

function ownOpacity(element: Element): number {
  const fromStyle = /(?:^|;)\s*opacity\s*:\s*([0-9.]+)/.exec(element.getAttribute('style') ?? '')?.[1];
  const value = Number.parseFloat(fromStyle ?? element.getAttribute('opacity') ?? '1');
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

interface GroupNode {
  element: Element;
  children: Array<GroupNode | FabricObject>;
}
function rebuildGroups(objects: readonly FabricObject[], elements: readonly Element[], root: Element): FabricObject[] {
  const top: Array<GroupNode | FabricObject> = [];
  const nodes = new Map<Element, GroupNode>();
  const groupNodes = new Set<GroupNode>();
  const chains = new Map<FabricObject, Element[]>();
  const elementOf = new Map<FabricObject, Element>();
  objects.forEach((object, index) => {
    const element = elements[index]!;
    elementOf.set(object, element);
    const chain: Element[] = [];
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent.hasAttribute(GROUP_MARK)) chain.push(parent);
    }
    chains.set(object, chain);
    let children = top;
    for (let level = chain.length - 1; level >= 0; level -= 1) {
      const groupElement = chain[level]!;
      let node = nodes.get(groupElement);
      if (!node) {
        node = { element: groupElement, children: [] };
        nodes.set(groupElement, node);
        groupNodes.add(node);
        children.push(node);
      }
      children = node.children;
    }
    children.push(object);
    const own = element.getAttribute('id');
    const leaf = object as FabricObject & { id?: unknown };
    if (!own && chain.length > 0 && leaf.id !== undefined) delete leaf.id;
    const inherited = chain.reduce((product, groupElement) => product * ownOpacity(groupElement), 1);
    if (inherited > 0) object.opacity = Math.min(1, object.opacity / inherited);
    object.set(svgMetadata(element));
  });
  const hoistClip = (node: GroupNode, group: Group): void => {
    if (!node.element.hasAttribute('clip-path')) return;
    let clip: FabricObject | undefined;
    for (const object of objects) {
      const chain = chains.get(object)!;
      const at = chain.indexOf(node.element);
      if (at === -1) continue;
      const element = elementOf.get(object)!;
      const closer = element.hasAttribute('clip-path') || chain.slice(0, at).some((between) => between.hasAttribute('clip-path'));
      if (closer || !object.clipPath) continue;
      if (!clip) {
        const absolute = util.multiplyTransformMatrices(object.calcTransformMatrix(), object.clipPath.calcTransformMatrix());
        clip = object.clipPath as FabricObject;
        util.applyTransformToObject(clip, util.multiplyTransformMatrices(util.invertTransform(group.calcTransformMatrix()), absolute));
      }
      object.clipPath = undefined;
      object.set('dirty', true);
    }
    if (clip) group.clipPath = clip;
  };

  const build = (item: GroupNode | FabricObject): FabricObject => {
    if (!groupNodes.has(item as GroupNode)) return item as FabricObject;
    const node = item as GroupNode;
    const group = new Group(node.children.map(build));
    group.set({ opacity: ownOpacity(node.element), ...svgMetadata(node.element) });
    const id = node.element.getAttribute('id');
    if (id) (group as Group & { id?: string }).id = id;
    hoistClip(node, group);
    group.setCoords();
    return group;
  };
  return top.map(build);
}

/** Parses and places an SVG. Adding the result to a canvas is up to the caller. */
export async function readSvg(svg: string, options: SvgImportOptions = {}, limits: ContentLimits = {}): Promise<SvgImportResult> {
  if (typeof svg !== 'string' || svg.trim().length === 0) refuse('The SVG is empty');
  const warnings: SvgImportWarning[] = [];
  const document = parse(svg);
  sanitize(document, limits, warnings);
  dropBrokenUses(document);
  if (options.preserveGroups) markGroups(document);

  let parsed: Awaited<ReturnType<typeof parseSVGDocument>>;
  try {
    parsed = await parseSVGDocument(document, undefined, {
      crossOrigin: options.crossOrigin === undefined ? 'anonymous' : options.crossOrigin,
      signal: options.signal,
    });
  } catch (error) {
    if (isDocumentEngineError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    refuse(`Fabric could not read the SVG: ${reason}`, error);
  }
  if (options.signal?.aborted) {
    throw new DocumentEngineError('LOAD_ABORTED', 'The SVG import was cancelled');
  }
  let objects = parsed.objects.filter((object): object is FabricObject => object !== null && object !== undefined);
  if (options.preserveGroups) {
    const elements = parsed.elements.filter((_, index) => parsed.objects[index] !== null && parsed.objects[index] !== undefined);
    objects = rebuildGroups(objects, elements, document.documentElement);
  }

  const declared = { width: parsed.options.width ?? 0, height: parsed.options.height ?? 0 };
  const useContent = options.viewport === 'content' || declared.width <= 0 || declared.height <= 0;
  const bounds = useContent ? contentBounds(objects) : { left: 0, top: 0, ...declared };

  const offscreen = options.offscreen ?? 'keep';
  if (offscreen === 'drop' && !useContent) {
    const kept = objects.filter((object) => intersectsViewport(object, bounds.width, bounds.height));
    if (kept.length < objects.length) {
      warnings.push({ code: 'SVG_OFFSCREEN_DROPPED', message: `${objects.length - kept.length} elements outside the SVG's viewport were left out` });
    }
    objects = kept;
  }
  const viewport = { width: bounds.width, height: bounds.height };
  if (objects.length === 0) return { objects: [], viewport, warnings };

  // A fixed frame the size of the viewport, centred on it, so nothing inside
  // can move or resize the group.
  const group = new Group([], {
    layoutManager: new LayoutManager(new FixedLayout()),
    width: bounds.width,
    height: bounds.height,
    left: bounds.left + bounds.width / 2,
    top: bounds.top + bounds.height / 2,
    originX: 'center',
    originY: 'center',
  });
  group.add(...objects);
  if (offscreen === 'clip') {
    group.clipPath = new Rect({ width: bounds.width, height: bounds.height, originX: 'center', originY: 'center', left: 0, top: 0 });
  }

  let scaleX = 1;
  let scaleY = 1;
  let shiftX = 0;
  let shiftY = 0;
  const fit = options.fit;
  if (fit && bounds.width > 0 && bounds.height > 0) {
    const sx = fit.width / bounds.width;
    const sy = fit.height / bounds.height;
    const mode = fit.mode ?? 'contain';
    if (mode === 'fill') {
      scaleX = sx;
      scaleY = sy;
    } else {
      scaleX = scaleY = mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
      shiftX = (fit.width - bounds.width * scaleX) / 2;
      shiftY = (fit.height - bounds.height * scaleY) / 2;
    }
  }
  group.set({
    scaleX,
    scaleY,
    originX: 'left',
    originY: 'top',
    left: (options.left ?? 0) + shiftX,
    top: (options.top ?? 0) + shiftY,
  });
  group.setCoords();

  if ((options.as ?? 'group') === 'group') return { objects: [group], viewport, warnings };

  const clip = group.clipPath;
  group.clipPath = undefined;
  const loose = group.removeAll();
  if (clip) {
    const frame = group.calcTransformMatrix();
    for (const object of loose) {
      const absoluteClip = new Rect({ width: bounds.width, height: bounds.height, originX: 'center', originY: 'center', absolutePositioned: true });
      absoluteClip.set({ left: frame[4], top: frame[5], scaleX, scaleY });
      object.clipPath = absoluteClip;
    }
  }
  loose.forEach((object) => object.setCoords());
  return { objects: loose, viewport, warnings };
}
