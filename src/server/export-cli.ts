// Node entry point the Python integration API runs per request:
//
//   node dist-server/export-workbook.mjs doc-types   < (nothing)
//   node dist-server/export-workbook.mjs build       < ExportRequest JSON
//   node dist-server/export-workbook.mjs build-rows  < { rows, provider, options }
//
// Writes one JSON object to stdout. Exit 0 = success, 2 = invalid request
// (message on stderr, reported as 422), anything else = internal failure.
// ``build-rows`` calls the browser builder with browser-shaped rows; the
// parity tests use it as the reference the API output must match.
import { Buffer } from 'node:buffer';
import { buildExportWorkbook, type ExportOptions } from '@/lib/excel-export';
import type { ExtractedRow } from '@/types/utilscraper';
import { buildWorkbookForRequest, docTypeCatalog, ExportRequestError, type ExportRequest } from './export-request';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parse<T>(text: string): T {
  try {
    return JSON.parse(text);
  } catch {
    throw new ExportRequestError('Request body is not valid JSON');
  }
}

async function run(command: string | undefined): Promise<unknown> {
  if (command === 'doc-types') return docTypeCatalog();
  if (command === 'build') {
    const { buffer, filename, unknownFields } = await buildWorkbookForRequest(parse<ExportRequest>(await readStdin()));
    return { filename, unknown_fields: unknownFields, xlsx_base64: Buffer.from(buffer).toString('base64') };
  }
  if (command === 'build-rows') {
    const body = parse<{ rows: ExtractedRow[]; provider: string; options?: ExportOptions }>(await readStdin());
    const { buffer, filename } = await buildExportWorkbook(body.rows, body.provider, body.options ?? {});
    return { filename, xlsx_base64: Buffer.from(buffer).toString('base64') };
  }
  throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

run(process.argv[2]).then(
  result => { process.stdout.write(JSON.stringify(result)); },
  err => {
    process.stderr.write(String(err instanceof Error ? err.message : err));
    process.exitCode = err instanceof ExportRequestError ? 2 : 1;
  },
);
