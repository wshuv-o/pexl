export type DocumentType = 'utility_bill' | 'bank_statement' | 'appraisal' | 'lease_contract' | 'tax';

export const DOCUMENT_TYPES: { value: DocumentType; label: string; color: string }[] = [
  { value: 'utility_bill',   label: 'Utility Bill',    color: '#16a34a' },
  { value: 'bank_statement', label: 'Bank Statement',  color: '#2563eb' },
  { value: 'appraisal',       label: 'Appraisal',       color: '#9333ea' },
  { value: 'lease_contract',  label: 'Lease Contract',  color: '#d97706' },
  { value: 'tax',             label: 'Tax',             color: '#dc2626' },
];

export interface PageInfo {
  page_number: number;
  is_ocr: boolean;
  char_count: number;
  status: 'native' | 'ocr';
}

export interface PDFSession {
  id: string;
  filename: string;
  file: File | undefined;   // undefined when session is restored without original File object
  folderName?: string;      // top-level folder name when uploaded via folder picker
  docType: DocumentType;
  total_pages: number;
  pages: PageInfo[];
  status: 'uploading' | 'processing' | 'ready' | 'extracted';
  highlights: Record<number, Highlight[]>;
  extractedData: ExtractedRow[];
  startPage: number;         // first "content" page (1-based) — pages before this are cover pages
}

export interface Highlight {
  id: string;
  page: number;
  field: string;             // string (not FieldLabel) so custom labels work without a cast
  x: number;
  y: number;
  width: number;
  height: number;
  extractedValue?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  wasOcr?: boolean;
  isAutoExtracted?: boolean;  // true = coords are approximate, skip on Re-Extract
}

export type FieldLabel =
  | 'provider_name'
  | 'property_name'
  | 'account_number'
  | 'address'
  | 'billing_date'
  | 'date'
  | 'total_gas_bill'
  | 'total_electricity_bill'
  | 'total_internet_bill'
  | 'total_phone_bill'
  | 'total_water_bill'
  | 'total_sewer_bill'
  | 'total_water_sewer_bill'
  | 'total_trash_bill'
  | 'other_charges'
  | 'taxes'
  | 'total_utilities'
  // Bank statement fields
  | 'beginning_balance'
  | 'ending_balance'
  | 'statement_date'
  | 'total_credits'
  | 'total_debits'
  // Appraisal fields
  | 'appraised_date'
  | 'appraised_as_is_value'
  | 'property_type'
  | 'cap_rate'
  // Lease contract fields
  | 'lease_date'
  | 'parties'
  | 'landlord_name'
  | 'property_address'
  | 'unit_number'
  | 'utilities_included'
  | 'lease_begin_date'
  | 'lease_end_date'
  | 'security_deposit'
  | 'monthly_rent'
  | 'rent_and_charges'
  | 'onetime_concession_amount'
  | 'onetime_concession_comment'
  | 'monthly_discount'
  | 'other_discount'
  | 'other_discount_comment'
  | 'household_ca_count'
  | 'household_non_ca_count'
  | 'total_income_ca'
  | 'total_income_non_ca'
  | 'total_rent'
  | 'utility_allowance'
  | 'ca_shelter_allowance'
  | 'cityfheps_rent_supplement'
  | 'household_share'
  | 'utility_payment'
  | 'total_monthly_rent'
  // Tax fields
  | 'tax_year'
  | 'tax_bill_date'
  | 'tax_due_date'
  | 'tax_authority'
  | 'assessed_value'
  | 'total_tax_due'
  | 'parcel_id'
  | 'custom';

export interface FieldLabelOption {
  value: FieldLabel;
  label: string;
  color: string;
  bgColor: string;
  docTypes: DocumentType[];  // which document types show this field
}

export const FIELD_LABELS: FieldLabelOption[] = [
  // ── Utility bill fields ───────────────────────────────────────────
  { value: 'provider_name',         label: 'Provider Name',       color: '#1d4ed8', bgColor: 'rgba(29,78,216,0.18)',   docTypes: ['utility_bill'] },
  { value: 'property_name',         label: 'Property Name',       color: '#2563eb', bgColor: 'rgba(37,99,235,0.18)',   docTypes: ['utility_bill', 'bank_statement', 'appraisal', 'tax'] },
  { value: 'account_number',        label: 'Account Number',      color: '#0891b2', bgColor: 'rgba(8,145,178,0.18)',   docTypes: ['utility_bill', 'bank_statement', 'tax'] },
  { value: 'address',               label: 'Address',             color: '#0284c7', bgColor: 'rgba(2,132,199,0.18)',   docTypes: ['utility_bill', 'bank_statement', 'tax', 'lease_contract'] },
  { value: 'billing_date',          label: 'Billing Date',        color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)',  docTypes: ['utility_bill'] },
  { value: 'date',                  label: 'Date',                color: '#a855f7', bgColor: 'rgba(168,85,247,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_gas_bill',        label: 'Total Gas',           color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)',   docTypes: ['utility_bill'] },
  { value: 'total_electricity_bill',label: 'Total Electricity',   color: '#d97706', bgColor: 'rgba(217,119,6,0.18)',   docTypes: ['utility_bill'] },
  { value: 'total_water_bill',      label: 'Total Water',         color: '#0ea5e9', bgColor: 'rgba(14,165,233,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_sewer_bill',      label: 'Total Sewer',         color: '#0d9488', bgColor: 'rgba(13,148,136,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_water_sewer_bill',label: 'Total Water & Sewer', color: '#0369a1', bgColor: 'rgba(3,105,161,0.18)',   docTypes: ['utility_bill'] },
  { value: 'total_internet_bill',   label: 'Total Internet',      color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_phone_bill',      label: 'Total Phone',         color: '#9333ea', bgColor: 'rgba(147,51,234,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_trash_bill',       label: 'Total Trash',         color: '#65a30d', bgColor: 'rgba(101,163,13,0.18)',  docTypes: ['utility_bill'] },
  { value: 'other_charges',         label: 'Other Charges',       color: '#f59e0b', bgColor: 'rgba(245,158,11,0.18)',  docTypes: ['utility_bill'] },
  { value: 'taxes',                 label: 'Taxes',               color: '#6d28d9', bgColor: 'rgba(109,40,217,0.18)',  docTypes: ['utility_bill'] },
  { value: 'total_utilities',       label: 'Total Utilities',     color: '#059669', bgColor: 'rgba(5,150,105,0.18)',   docTypes: ['utility_bill'] },
  // ── Bank statement fields ─────────────────────────────────────────
  { value: 'beginning_balance',     label: 'Beginning Balance',   color: '#16a34a', bgColor: 'rgba(22,163,74,0.18)',   docTypes: ['bank_statement'] },
  { value: 'ending_balance',        label: 'Ending Balance',      color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)',   docTypes: ['bank_statement'] },
  { value: 'statement_date',        label: 'Statement Date',      color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)',  docTypes: ['bank_statement'] },
  { value: 'total_credits',         label: 'Total Credits',       color: '#0891b2', bgColor: 'rgba(8,145,178,0.18)',   docTypes: ['bank_statement'] },
  { value: 'total_debits',          label: 'Total Debits',        color: '#d97706', bgColor: 'rgba(217,119,6,0.18)',   docTypes: ['bank_statement'] },
  // ── Appraisal fields ──────────────────────────────────────────────
  { value: 'appraised_date',        label: 'Appraised Date',      color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)',  docTypes: ['appraisal'] },
  { value: 'appraised_as_is_value', label: 'Appraised As-Is Value', color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)', docTypes: ['appraisal'] },
  { value: 'property_type',        label: 'Property Type',          color: '#0891b2', bgColor: 'rgba(8,145,178,0.18)',  docTypes: ['appraisal'] },
  { value: 'cap_rate',             label: 'Cap Rate',               color: '#16a34a', bgColor: 'rgba(22,163,74,0.18)',  docTypes: ['appraisal'] },
  // ── Lease contract fields ───────────────────────────────────────────
  { value: 'lease_date',                label: 'Contract Date',            color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)',  docTypes: ['lease_contract'] },
  { value: 'parties',                   label: 'Tenant Name(s)',           color: '#1d4ed8', bgColor: 'rgba(29,78,216,0.18)',   docTypes: ['lease_contract'] },
  { value: 'landlord_name',             label: 'Landlord Name',            color: '#0891b2', bgColor: 'rgba(8,145,178,0.18)',   docTypes: ['lease_contract'] },
  { value: 'property_address',          label: 'Property Address',         color: '#0369a1', bgColor: 'rgba(3,105,161,0.18)',   docTypes: ['lease_contract'] },
  { value: 'unit_number',               label: 'Unit / Apt Number',        color: '#4f46e5', bgColor: 'rgba(79,70,229,0.18)',   docTypes: ['lease_contract'] },
  { value: 'utilities_included',        label: 'Utilities included in Rent', color: '#b45309', bgColor: 'rgba(180,83,9,0.18)', docTypes: ['lease_contract'] },
  { value: 'lease_begin_date',          label: 'Lease Start',              color: '#0891b2', bgColor: 'rgba(8,145,178,0.18)',   docTypes: ['lease_contract'] },
  { value: 'lease_end_date',            label: 'Lease End',                color: '#0284c7', bgColor: 'rgba(2,132,199,0.18)',   docTypes: ['lease_contract'] },
  { value: 'security_deposit',          label: 'Security Deposit',         color: '#16a34a', bgColor: 'rgba(22,163,74,0.18)',   docTypes: ['lease_contract'] },
  { value: 'monthly_rent',              label: 'Monthly Rent',             color: '#be123c', bgColor: 'rgba(190,18,60,0.18)',   docTypes: ['lease_contract'] },
  { value: 'rent_and_charges',          label: 'Rent & Charges',           color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)',   docTypes: ['lease_contract'] },
  { value: 'onetime_concession_amount', label: 'One-Time Concession $',    color: '#d97706', bgColor: 'rgba(217,119,6,0.18)',   docTypes: ['lease_contract'] },
  { value: 'onetime_concession_comment',label: 'One-Time Concession Note', color: '#9333ea', bgColor: 'rgba(147,51,234,0.18)', docTypes: ['lease_contract'] },
  { value: 'monthly_discount',          label: 'Monthly Discount $',       color: '#0ea5e9', bgColor: 'rgba(14,165,233,0.18)',  docTypes: ['lease_contract'] },
  { value: 'other_discount',            label: 'Other Discount $',         color: '#0d9488', bgColor: 'rgba(13,148,136,0.18)',  docTypes: ['lease_contract'] },
  { value: 'other_discount_comment',    label: 'Other Discount Comment',   color: '#65a30d', bgColor: 'rgba(101,163,13,0.18)', docTypes: ['lease_contract'] },
  { value: 'household_ca_count',        label: '# in HH Receiving CA',     color: '#1d4ed8', bgColor: 'rgba(29,78,216,0.18)',  docTypes: ['lease_contract'] },
  { value: 'household_non_ca_count',    label: '# in HH Not Receiving CA', color: '#2563eb', bgColor: 'rgba(37,99,235,0.18)',  docTypes: ['lease_contract'] },
  { value: 'total_income_ca',           label: 'Total Income (CA)',        color: '#16a34a', bgColor: 'rgba(22,163,74,0.18)',  docTypes: ['lease_contract'] },
  { value: 'total_income_non_ca',       label: 'Total Income (Non-CA)',    color: '#15803d', bgColor: 'rgba(21,128,61,0.18)',  docTypes: ['lease_contract'] },
  { value: 'total_rent',                label: 'Total Rent',               color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)',  docTypes: ['lease_contract'] },
  { value: 'utility_allowance',         label: 'Utility Allowance',        color: '#d97706', bgColor: 'rgba(217,119,6,0.18)',  docTypes: ['lease_contract'] },
  { value: 'ca_shelter_allowance',      label: 'CA Shelter Allowance',     color: '#b45309', bgColor: 'rgba(180,83,9,0.18)',   docTypes: ['lease_contract'] },
  { value: 'cityfheps_rent_supplement', label: 'CityFHEPS Rent Supplement',color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)', docTypes: ['lease_contract'] },
  { value: 'household_share',           label: 'Household Share',          color: '#0ea5e9', bgColor: 'rgba(14,165,233,0.18)', docTypes: ['lease_contract'] },
  { value: 'utility_payment',           label: 'Utility Payment',          color: '#0d9488', bgColor: 'rgba(13,148,136,0.18)', docTypes: ['lease_contract'] },
  { value: 'total_monthly_rent',        label: 'Total Monthly Rent',       color: '#be123c', bgColor: 'rgba(190,18,60,0.18)',  docTypes: ['lease_contract'] },
  // ── Tax fields ────────────────────────────────────────────────────
  { value: 'tax_year',        label: 'Tax Year',            color: '#7c3aed', bgColor: 'rgba(124,58,237,0.18)', docTypes: ['tax'] },
  { value: 'tax_bill_date',   label: 'Tax Bill Date',       color: '#0ea5e9', bgColor: 'rgba(14,165,233,0.18)', docTypes: ['tax'] },
  { value: 'tax_due_date',    label: 'Tax Due Date',        color: '#f97316', bgColor: 'rgba(249,115,22,0.18)', docTypes: ['tax'] },
  { value: 'tax_authority',   label: 'Tax Authority',       color: '#1d4ed8', bgColor: 'rgba(29,78,216,0.18)',  docTypes: ['tax'] },
  { value: 'assessed_value',  label: 'Assessed Value',      color: '#16a34a', bgColor: 'rgba(22,163,74,0.18)',  docTypes: ['tax'] },
  { value: 'total_tax_due',   label: 'Total Tax Due',       color: '#dc2626', bgColor: 'rgba(220,38,38,0.18)',  docTypes: ['tax'] },
  { value: 'parcel_id',       label: 'Parcel ID',           color: '#9333ea', bgColor: 'rgba(147,51,234,0.18)', docTypes: ['tax'] },
  // ── Fallback ──────────────────────────────────────────────────────
  { value: 'custom', label: 'Custom', color: '#64748b', bgColor: 'rgba(100,116,139,0.18)', docTypes: ['utility_bill', 'bank_statement', 'appraisal', 'lease_contract', 'tax'] },
];

// Returns only the field labels relevant to a document type
export function getFieldLabelsForType(docType: DocumentType): FieldLabelOption[] {
  return FIELD_LABELS.filter(f => f.docTypes.includes(docType));
}

// Accepts string (not just FieldLabel) so ExtractedRow.field values work without a cast.
// Falls back to the 'custom' config for any unknown label.
export function getFieldConfig(field: string): FieldLabelOption {
  return FIELD_LABELS.find(f => f.value === field)
    ?? { value: 'custom', label: field, color: '#64748b', bgColor: 'rgba(100,116,139,0.18)', docTypes: ['utility_bill', 'bank_statement', 'appraisal'] };
}

export interface ExtractedRow {
  page: number;
  field: string;
  value: string | null;
  confidence: 'high' | 'medium' | 'low';
  wasOcr: boolean;
  edited?: boolean;
  filename?: string;     // set when combining data from multiple PDFs
  folderName?: string;   // top-level folder name from the upload (if uploaded via folder picker)
  sessionId?: string;    // which session this row belongs to
}

export type ViewerTool = 'cursor' | 'highlight' | 'eraser' | 'text-select' | 'select' | 'table-select';