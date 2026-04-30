/**
 * Client-side rasterizer for vector-only PDFs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some PDFs (e.g. Panorama / Oakbrook rent rolls) contain ONLY vector path
 * drawings — no text layer, no embedded images. Those PDFs go through the
 * backend `/process` endpoint and come back empty because the pipeline has
 * no text to read and no rasterized image to OCR.
 *
 * INSTEAD OF CHANGING THE BACKEND, we do the work here:
 *   1. Detect that a PDF is vector-only (text + image counts both zero)
 *   2. Render each page to a PNG via pdfjs
 *   3. Repackage those PNGs into a new image-only PDF (via pdf-lib)
 *   4. Hand the new PDF to the existing upload flow — the backend's image
 *      OCR path picks it up and OCRs it as if it had been a scanned PDF.
 *
 * The result is a slightly larger File (raster images instead of vector
 * paths) but one that the existing pipeline understands end-to-end.
 */
import { pdfjs } from 'react-pdf';
import { PDFDocument } from 'pdf-lib';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export type PdfKind = 'text' | 'image' | 'vector' | 'empty' | 'mixed';

export interface PdfClassification {
  pages: number;
  perPage: PdfKind[];
  overall: PdfKind;
}

/**
 * Inspect a PDF File to figure out whether it has a usable text layer,
 * embedded images, or only vector drawings. The frontend uses this to
 * decide whether to rasterize before upload.
 */
export async function classifyPdf(file: File): Promise<PdfClassification> {
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdf = await (pdfjs as any).getDocument({ data: buf }).promise;

  const perPage: PdfKind[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // Text presence
    const tc = await page.getTextContent();
    const textLen = (tc.items ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
      .join('')
      .trim()
      .length;

    // Embedded image / drawing detection via the page operator list.
    let hasImage   = false;
    let hasDrawing = false;
    try {
      const ops = await page.getOperatorList();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const OPS: Record<string, number> = (pdfjs as any).OPS ?? {};
      for (const op of ops.fnArray) {
        if (!hasImage && (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject || op === OPS.paintJpegXObject)) {
          hasImage = true;
        }
        if (!hasDrawing && (op === OPS.fill || op === OPS.stroke || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.eoFill || op === OPS.constructPath)) {
          hasDrawing = true;
        }
        if (hasImage && hasDrawing) break;
      }
    } catch { /* op-list unavailable on some PDFs — fall through */ }

    if (textLen >= 10) perPage.push('text');
    else if (hasImage) perPage.push('image');
    else if (hasDrawing) perPage.push('vector');
    else perPage.push('empty');
  }

  const distinct = new Set(perPage);
  let overall: PdfKind;
  if (distinct.size === 1) overall = perPage[0];
  else if (distinct.has('vector') && !distinct.has('text') && !distinct.has('image')) overall = 'vector';
  else overall = 'mixed';

  return { pages: pdf.numPages, perPage, overall };
}

/**
 * Convenience: returns true iff the PDF is vector-only (no text layer,
 * no embedded images on any page, but has at least one page with
 * drawings). These are the PDFs the existing backend can't handle.
 */
export async function isVectorOnlyPdf(file: File): Promise<boolean> {
  const c = await classifyPdf(file);
  // Every non-empty page must be 'vector'. Empty pages (truly blank) are fine.
  let sawVector = false;
  for (const k of c.perPage) {
    if (k === 'text' || k === 'image') return false;
    if (k === 'vector') sawVector = true;
  }
  return sawVector;
}

/**
 * Render each page of `file` to a PNG bitmap using pdfjs.
 * Returns one Uint8Array per page (PNG bytes).
 */
async function renderPagesToPng(file: File, dpi: number): Promise<Uint8Array[]> {
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdf = await (pdfjs as any).getDocument({ data: buf }).promise;
  const out: Uint8Array[] = [];
  // 72 DPI is the PDF base; scale = dpi / 72.
  const scale = dpi / 72;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'),
    );
    out.push(new Uint8Array(await blob.arrayBuffer()));
    // Drop refs so we don't hold every page in memory at once on big PDFs.
    canvas.width = 0; canvas.height = 0;
  }
  return out;
}

/**
 * Build a new image-only PDF from the rasterized pages. Each PNG becomes
 * one page sized to keep the original page's aspect ratio.
 */
async function buildPdfFromPngs(pngs: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const png of pngs) {
    const img = await out.embedPng(png);
    const page = out.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return out.save();
}

/**
 * One-shot: takes a vector-only File and returns a new File where every
 * page has been rasterized to a PNG and embedded as an image. The
 * returned File has the same display name with " (rasterized).pdf" so
 * the user sees what happened in tabs / downloads.
 *
 * @param file       source PDF
 * @param dpi        rasterization resolution (default 200; bump to 300
 *                   for small fonts at the cost of file size + time)
 * @param onProgress optional 0..1 callback fired as pages render
 */
export async function rasterizeVectorPdf(
  file: File,
  dpi: number = 200,
  onProgress?: (pct: number) => void,
): Promise<File> {
  if (onProgress) onProgress(0);
  const pngs = await renderPagesToPng(file, dpi);
  if (onProgress) onProgress(0.7);
  const pdfBytes = await buildPdfFromPngs(pngs);
  if (onProgress) onProgress(1);

  const stem = file.name.replace(/\.pdf$/i, '');
  return new File([new Uint8Array(pdfBytes)], `${stem} (rasterized).pdf`, {
    type: 'application/pdf',
    lastModified: Date.now(),
  });
}

/**
 * Convenience wrapper: classify, and if vector-only, rasterize. Otherwise
 * return the original File untouched. Use this as a drop-in pre-step
 * before sending a File into the existing upload pipeline.
 */
export async function rasterizeIfVectorOnly(
  file: File,
  opts: { dpi?: number; onProgress?: (pct: number) => void } = {},
): Promise<{ file: File; rasterized: boolean }> {
  if (await isVectorOnlyPdf(file)) {
    const out = await rasterizeVectorPdf(file, opts.dpi ?? 200, opts.onProgress);
    return { file: out, rasterized: true };
  }
  return { file, rasterized: false };
}
