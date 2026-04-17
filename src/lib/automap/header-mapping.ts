import { FIELD_LABELS, type FieldLabel, type DocumentType } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Manual header → canonical-field mapping. This module intentionally does
// NO fuzzy matching, similarity scoring, or AI-style inference. Every Excel
// header starts as Unmapped; the user picks the canonical field from the
// same alphabetised dropdown.
// ───────────────────────────────────────────────────────────────────────────

export interface FieldOption {
  fieldKey:   FieldLabel;
  fieldLabel: string;
  docTypes:   DocumentType[];
}

export interface HeaderToField {
  excelHeader: string;
  fieldKey:    FieldLabel | null;
  fieldLabel:  string | null;
  searchText:  string;              // exact phrase the user wants to find in the PDF
}

// Full list of canonical fields, alphabetised. Filter by docType on the UI
// so only fields relevant to the chosen doc type appear in the dropdown.
export const ALL_FIELDS: FieldOption[] = FIELD_LABELS
  .filter(f => f.value !== 'custom')
  .map(f => ({ fieldKey: f.value, fieldLabel: f.label, docTypes: f.docTypes }))
  .sort((a, b) => a.fieldLabel.localeCompare(b.fieldLabel));

export function fieldsForDocType(docType: DocumentType | null): FieldOption[] {
  if (!docType) return ALL_FIELDS;
  return ALL_FIELDS.filter(f => f.docTypes.includes(docType));
}

// Build one unmapped entry per Excel header — no auto-selection.
export function buildInitialMappings(headers: string[]): HeaderToField[] {
  return headers.map(h => ({
    excelHeader: h,
    fieldKey:    null,
    fieldLabel:  null,
    searchText:  '',
  }));
}
