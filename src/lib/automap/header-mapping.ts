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
}

// All selectable canonical fields, sorted by display label. Computed once.
export const ALL_FIELDS: FieldOption[] = FIELD_LABELS
  .filter(f => f.value !== 'custom')
  .map(f => ({ fieldKey: f.value, fieldLabel: f.label, docTypes: f.docTypes }))
  .sort((a, b) => a.fieldLabel.localeCompare(b.fieldLabel));

// Build one unmapped entry per Excel header — no auto-selection.
export function buildInitialMappings(headers: string[]): HeaderToField[] {
  return headers.map(h => ({
    excelHeader: h,
    fieldKey:    null,
    fieldLabel:  null,
  }));
}
