import type { StaticCanvas } from 'fabric';

/** Draws SVG markup the way an <img> shows it, at the given size. */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The canvas as Fabric draws it, on white. */
export function rasterizeCanvas(canvas: StaticCanvas): ImageData {
  const drawn = canvas.toCanvasElement(1);
  const flat = document.createElement('canvas');
  flat.width = drawn.width;
  flat.height = drawn.height;
  const context = flat.getContext('2d')!;
  context.fillStyle = 'white';
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(drawn, 0, 0);
  return context.getImageData(0, 0, flat.width, flat.height);
}

/**
 * The share of inked pixels that differ clearly between two drawings. Text
 * edges are smoothed a little differently by canvas and SVG, so small
 * differences in a pixel do not count, and neither does a pixel that is
 * matched by a neighbour one pixel away.
 */
export function inkDifference(first: ImageData, second: ImageData, threshold = 96): number {
  const { width, height } = first;
  const at = (image: ImageData, x: number, y: number): number[] => {
    const index = (y * width + x) * 4;
    return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!];
  };
  const isInk = (pixel: number[]): boolean => pixel.some((channel) => channel < 235);
  const close = (a: number[], b: number[]): boolean => a.every((channel, index) => Math.abs(channel - b[index]!) <= threshold);
  const matchedNearby = (image: ImageData, x: number, y: number, pixel: number[]): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (close(at(image, nx, ny), pixel)) return true;
      }
    }
    return false;
  };
  let ink = 0;
  let different = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = at(first, x, y);
      const b = at(second, x, y);
      if (!isInk(a) && !isInk(b)) continue;
      ink += 1;
      if (!matchedNearby(second, x, y, a) || !matchedNearby(first, x, y, b)) different += 1;
    }
  }
  return ink === 0 ? 0 : different / ink;
}
