import * as pdfjs from 'pdfjs-dist';
// Vite turns this into the worker file's URL.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfPageInfo {
  /** Page size in points. */
  width: number;
  height: number;
  /** The text pdf.js finds on the page, which is only there for real text. */
  text: string;
}

export async function readPdf(blob: Blob): Promise<{ pages: PdfPageInfo[]; info: Record<string, unknown> }> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const document = await task.promise;
  try {
    const pages: PdfPageInfo[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
      pages.push({ width, height, text });
    }
    const metadata = await document.getMetadata();
    return { pages, info: (metadata.info ?? {}) as Record<string, unknown> };
  } finally {
    await task.destroy();
  }
}

/** Draws one page of a PDF on white, at the given pixel size. */
export async function rasterizePdfPage(blob: Blob, pageNumber: number, width: number, height: number): Promise<ImageData> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const document = await task.promise;
  try {
    const page = await document.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / unscaled.width });
    const canvas = document_createCanvas(width, height);
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return context.getImageData(0, 0, width, height);
  } finally {
    await task.destroy();
  }
}

function document_createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
