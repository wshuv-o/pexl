// Label-text search queries for each field. Used by the auto-highlight
// dialog to find the LABEL text in the PDF — the corresponding data value
// is then offset to the right of / below that label.
export const FIELD_LABEL_SYNONYMS: Record<string, string[]> = {
  // ── Utility bill ──────────────────────────────────────────────────
  provider_name:         ['provider', 'utility company', 'supplier'],
  property_name:         ['property name', 'customer name', 'account holder', 'bill to', 'name on account'],
  account_number:        ['account number', 'account no', 'account #', 'acct no', 'acct #'],
  address:               ['service address', 'premises', 'service location', 'address'],
  billing_date:          ['billing date', 'bill date', 'statement date', 'invoice date', 'date of bill', 'bill issue date'],
  total_gas_bill:        ['total gas', 'gas charges', 'total amount due', 'toal charges'],
  total_electricity_bill:['total electricity', 'electric charges', 'electricity charges', 'total charges'],
  total_water_bill:      ['total water', 'water charges', 'amount due','total charges'],
  total_sewer_bill:      ['total sewer', 'sewer charges','total charges'],
  total_water_sewer_bill:['total water & sewer', 'water and sewer','total charges'],
  total_internet_bill:   ['total internet', 'internet charges','total charges'],
  total_phone_bill:      ['total phone', 'phone charges', 'telecom charges', 'communication charges','total charges'],
  total_trash_bill:      ['total trash', 'trash charges', 'refuse', 'garbage', 'total charges'],

  // ── Bank statement ────────────────────────────────────────────────
  beginning_balance:     ['beginning balance', 'opening balance', 'previous balance'],
  ending_balance:        ['ending balance', 'closing balance', 'new balance'],
  statement_date:        ['statement date', 'billing date', 'bill date', 'period ending', 'date of bill'],
  total_credits:         ['total credits', 'total deposits', 'credits', 'deposits'],
  total_debits:          ['total debits', 'total withdrawals', 'debits', 'withdrawals'],

  // ── Appraisal ─────────────────────────────────────────────────────
  appraised_date:        ['appraised date', 'appraisal date', 'valuation date', 'effective date', 'as of date'],
  appraised_as_is_value: ['as-is value', 'appraised value', 'market value', 'as is value', 'assessed value', 'appraisal'],
  property_type:         ['property type', 'asset type', 'type of property', 'type'],
  cap_rate:              ['cap rate', 'capitalization rate', 'capitalization', 'cap','OAR', 'terminal capitalization rate','direct capitalization'],

  // ── Lease contract ────────────────────────────────────────────────
  lease_date:                 ['contract date', 'lease date', 'agreement date'],
  parties:                    ['tenant name', 'tenant', 'lessee', 'renter', 'resident' ],
  utilities_included:         ['utilities included', 'utilities', 'included utilities'],
  lease_begin_date:           ['lease start', 'lease begin', 'lease commencement', 'start date'],
  lease_end_date:             ['lease end', 'lease expiration', 'end date', 'termination date', 'expiry date'],
  security_deposit:           ['security deposit', 'deposit'],
  monthly_rent:               ['monthly rent', 'rent', 'base rent', 'rent amount'],
  rent_and_charges:           ['rent and charges', 'rent & charges', 'total rent'],
  onetime_concession_amount:  ['concession', 'one-time concession', 'rent concession'],
  onetime_concession_comment: ['concession note', 'concession comment', 'concession description'],
  monthly_discount:           ['monthly discount', 'discount'],
  other_discount:             ['other discount'],
  other_discount_comment:     ['other discount comment'],
  household_ca_count:         ['receiving cash assistance', 'receiving ca', 'individuals receiving'],
  household_non_ca_count:     ['not receiving cash assistance', 'not receiving ca'],
  total_income_ca:            ['total income', 'income receiving ca', 'income ca'],
  total_income_non_ca:        ['total income', 'income not receiving ca', 'income non-ca'],
  total_rent:                 ['total rent'],
  utility_allowance:          ['utility allowance'],
  ca_shelter_allowance:       ['shelter allowance', 'ca shelter allowance'],
  cityfheps_rent_supplement:  ['cityfheps rent supplement', 'cityfheps', 'rent supplement'],
  household_share:            ['household share', 'tenant share'],
  utility_payment:            ['utility payment'],
  total_monthly_rent:         ['total monthly rent', 'monthly rent total'],

  // ── Tax ───────────────────────────────────────────────────────────
  tax_year:                   ['tax year', 'assessment year'],
  tax_bill_date:              ['tax bill date', 'bill date'],
  tax_due_date:               ['tax due date', 'due date', 'payment due'],
  tax_authority:              ['tax authority', 'assessor', 'assessing office', 'collector'],
  assessed_value:             ['assessed value', 'assessment', 'taxable value'],
  total_tax_due:              ['total tax due', 'total due', 'amount due', 'tax due', 'total tax', 'amount', 'tax', 'taxes', 'total tax bill'],
  parcel_id:                  ['parcel id', 'parcel number', 'apn', 'property id', 'tax id', 'account number'],
};

// Returns queries for a field, falling back to the field key itself
// (underscores → spaces) for custom fields or fields without synonyms.
export function queriesFor(fieldKey: string): string[] {
  return FIELD_LABEL_SYNONYMS[fieldKey] ?? [fieldKey.replace(/_/g, ' ')];
}
