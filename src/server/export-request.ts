// Server-side "export by document type". Turns a FinAi API request into the
// same ExtractedRow[] the browser holds and hands it to buildExportWorkbook —
// the exact builder behind the Export button — so there is one layout, not two.
// Must stay free of DOM/Vite-only imports: it runs under plain Node.
import { buildExportWorkbook } from '@/lib/excel-export';
import type { UtilityDateField } from '@/lib/utility-excel-export';
import {
  DOCUMENT_TYPES,
  getFieldLabelsForType,
  type DocumentType,
  type ExtractedRow,
} from '@/types/utilscraper';

export interface ExportRequestRow {
  page: number;
  field: string;
  value: string | null;
  confidence?: ExtractedRow['confidence'];
  wasOcr?: boolean;
}

export interface ExportRequestFile {
  filename: string;
  folder_name?: string;
  rows: ExportRequestRow[];
}

export interface ExportRequest {
  doc_type: string;
  external_reference?: string | null;
  options?: { date_field?: UtilityDateField };
  files: ExportRequestFile[];
}

export interface DocTypeInfo {
  value: DocumentType;
  label: string;
  fields: { value: string; label: string }[];
}

/** Thrown for a request the builder cannot accept; the CLI reports it as a 422. */
export class ExportRequestError extends Error {}

const DATE_FIELD_MODES: UtilityDateField[] = ['auto', 'billing_date', 'date'];
const CONFIDENCES: ExtractedRow['confidence'][] = ['high', 'medium', 'low'];

export function docTypeCatalog(): DocTypeInfo[] {
  return DOCUMENT_TYPES.map(t => ({
    value: t.value,
    label: t.label,
    fields: getFieldLabelsForType(t.value)
      .filter(f => f.value !== 'custom')
      .map(f => ({ value: f.value, label: f.label })),
  }));
}

/**
 * Convert API files to browser-shaped rows. Each file gets its own
 * sessionId, as each uploaded PDF does in the browser, so two files that
 * share a filename stay separate wherever the exporters group by session.
 */
export function requestToRows(request: ExportRequest): ExtractedRow[] {
  const rows: ExtractedRow[] = [];
  request.files.forEach((file, i) => {
    for (const r of file.rows) {
      rows.push({
        page: r.page,
        field: r.field,
        value: r.value,
        confidence: r.confidence ?? 'high',
        wasOcr: r.wasOcr ?? false,
        filename: file.filename,
        ...(file.folder_name ? { folderName: file.folder_name } : {}),
        sessionId: `api-file-${i + 1}`,
      });
    }
  });
  return rows;
}

/**
 * Fields the doc type's layout does not know. They still land in the Plain
 * Data sheet (as in the browser) but get no templated column, so callers are
 * told rather than silently losing a misspelt key. ``<field>_expr`` carries a
 * known field's source arithmetic and is not reported.
 */
export function unknownFields(request: ExportRequest): string[] {
  if (request.doc_type === 'others') return [];
  const known = new Set<string>(getFieldLabelsForType(request.doc_type as DocumentType).map(f => f.value));
  const unknown = new Set<string>();
  for (const file of request.files) {
    for (const r of file.rows) {
      const base = r.field.endsWith('_expr') ? r.field.slice(0, -5) : r.field;
      if (!known.has(base)) unknown.add(r.field);
    }
  }
  return Array.from(unknown).sort();
}

function validate(request: ExportRequest): void {
  if (!DOCUMENT_TYPES.some(t => t.value === request.doc_type)) {
    throw new ExportRequestError(`Unknown doc_type: ${request.doc_type}`);
  }
  const mode = request.options?.date_field;
  if (mode !== undefined && !DATE_FIELD_MODES.includes(mode)) {
    throw new ExportRequestError(`Unknown options.date_field: ${mode}`);
  }
  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new ExportRequestError('files must contain at least one file');
  }
  request.files.forEach((file, fi) => {
    if (typeof file.filename !== 'string' || !file.filename.trim()) {
      throw new ExportRequestError(`files[${fi}].filename must be a non-empty string`);
    }
    if (!Array.isArray(file.rows)) throw new ExportRequestError(`files[${fi}].rows must be a list`);
    file.rows.forEach((r, ri) => {
      const at = `files[${fi}].rows[${ri}]`;
      if (!Number.isInteger(r.page) || r.page < 1) throw new ExportRequestError(`${at}.page must be a positive integer`);
      if (typeof r.field !== 'string' || !r.field) throw new ExportRequestError(`${at}.field must be a non-empty string`);
      if (r.value !== null && typeof r.value !== 'string') throw new ExportRequestError(`${at}.value must be a string or null`);
      if (r.confidence !== undefined && !CONFIDENCES.includes(r.confidence)) {
        throw new ExportRequestError(`${at}.confidence must be high, medium or low`);
      }
    });
  });
}

/** The filename stem the browser takes from the batch name; here, the run id. */
function filenameStem(request: ExportRequest): string {
  const ref = (request.external_reference ?? '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  return ref.slice(0, 80) || request.doc_type;
}

export async function buildWorkbookForRequest(request: ExportRequest) {
  validate(request);
  const { buffer, filename } = await buildExportWorkbook(requestToRows(request), filenameStem(request), {
    forceDocType: request.doc_type as DocumentType,
    dateField: request.options?.date_field ?? 'auto',
  });
  return { buffer, filename, unknownFields: unknownFields(request) };
}
