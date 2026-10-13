# Pexl field reference

Every extracted value in Pexl is a `(page, field, value)` triple. `field` is a
string key — the ones below are predefined per document type, and anything
else is treated as a custom label. This is the contract to match when
integrating another app.

Source of truth: [`src/types/utilscraper.ts`](../src/types/utilscraper.ts)
(`DocumentType`, `FieldLabel`, `FIELD_LABELS`). Value shaping lives in
[`src/lib/api.ts`](../src/lib/api.ts) (`sanitizeResults`) and
[`backend/main.py`](../backend/main.py).

## Document types

| `DocumentType` | Label |
|---|---|
| `utility_bill` | Utility Bill |
| `bank_statement` | Bank Statement |
| `appraisal` | Appraisal |
| `lease_contract` | Lease Contract |
| `tax` | Tax |
| `others` | Others — free-form, no predefined fields |

`custom` is available on every type. Under `others` it is the *only* option:
each highlight carries a user-typed label, those labels live in session state
only, and they vanish on a hard refresh.

## utility_bill

| Field key | Label | Type |
|---|---|---|
| `provider_name` | Provider Name | text |
| `property_name` | Property Name | text |
| `account_number` | Account Number | text |
| `address` | Address | text |
| `billing_date` | Billing Date | date |
| `date` | Date | text (**not** normalised — see below) |
| `total_gas_bill` | Total Gas | amount |
| `total_electricity_bill` | Total Electricity | amount |
| `total_water_bill` | Total Water | amount |
| `total_sewer_bill` | Total Sewer | amount |
| `total_water_sewer_bill` | Total Water & Sewer | amount |
| `total_internet_bill` | Total Internet | amount |
| `total_phone_bill` | Total Phone | amount |
| `total_trash_bill` | Total Trash | amount |
| `other_charges` | Other Charges | text |
| `taxes` | Taxes | text |
| `total_utilities` | Total Utilities | amount |

The utility template also reads two fields the importer writes but the
highlight UI doesn't offer: `service_start_date` / `service_end_date`
(`service_end_date` seeds `billing_date`), and `<amount field>_expr`, which
carries the literal arithmetic of a source spreadsheet cell so `=1.2+2.3`
survives into the generated report. See
[`PEXL_USAGE_API.md`](./PEXL_USAGE_API.md)'s sibling notes in
[`backend/utility_import.py`](../backend/utility_import.py).

## bank_statement

| Field key | Label | Type |
|---|---|---|
| `property_name` | Property Name | text |
| `account_number` | Account Number | text |
| `address` | Address | text |
| `statement_date` | Statement Date | date |
| `beginning_balance` | Beginning Balance | amount |
| `ending_balance` | Ending Balance | amount |
| `total_credits` | Total Credits | amount |
| `total_debits` | Total Debits | amount |

## appraisal

| Field key | Label | Type |
|---|---|---|
| `property_name` | Property Name | text |
| `appraised_date` | Appraised Date | date |
| `appraised_as_is_value` | Appraised As-Is Value | amount |
| `property_type` | Property Type | text |
| `cap_rate` | Cap Rate | text (**not** normalised — see below) |

## lease_contract

| Field key | Label | Type |
|---|---|---|
| `lease_date` | Contract Date | date |
| `parties` | Tenant Name(s) | text |
| `landlord_name` | Landlord Name | text |
| `address` | Address | text |
| `property_address` | Property Address | text |
| `unit_number` | Unit / Apt Number | text |
| `utilities_included` | Utilities included in Rent | text |
| `lease_begin_date` | Lease Start | date |
| `lease_end_date` | Lease End | date |
| `security_deposit` | Security Deposit | amount |
| `monthly_rent` | Monthly Rent | amount |
| `rent_and_charges` | Rent & Charges | amount |
| `onetime_concession_amount` | One-Time Concession $ | amount |
| `onetime_concession_comment` | One-Time Concession Note | text |
| `monthly_discount` | Monthly Discount $ | amount |
| `other_discount` | Other Discount $ | amount |
| `other_discount_comment` | Other Discount Comment | text |
| `household_ca_count` | # in HH Receiving CA | text |
| `household_non_ca_count` | # in HH Not Receiving CA | text |
| `total_income_ca` | Total Income (CA) | amount |
| `total_income_non_ca` | Total Income (Non-CA) | amount |
| `total_rent` | Total Rent | amount |
| `utility_allowance` | Utility Allowance | amount |
| `ca_shelter_allowance` | CA Shelter Allowance | amount |
| `cityfheps_rent_supplement` | CityFHEPS Rent Supplement | amount |
| `household_share` | Household Share | amount |
| `utility_payment` | Utility Payment | amount |
| `total_monthly_rent` | Total Monthly Rent | amount |

## tax

| Field key | Label | Type |
|---|---|---|
| `property_name` | Property Name | text |
| `account_number` | Account Number | text |
| `address` | Address | text |
| `tax_year` | Tax Year | year |
| `tax_bill_date` | Tax Bill Date | date |
| `tax_due_date` | Tax Due Date | date |
| `tax_authority` | Tax Authority | text |
| `assessed_value` | Assessed Value | amount |
| `total_tax_due` | Total Tax Due | amount |
| `parcel_id` | Parcel ID | text |

## Value shapes

| Type | Shape | Applied to |
|---|---|---|
| date | `MM/DD/YYYY` | `billing_date`, `statement_date`, `appraised_date`, `lease_date`, `lease_begin_date`, `lease_end_date`, `tax_bill_date`, `tax_due_date` |
| amount | plain decimal, 2 dp, no `$` or thousands separators (`1151.39`) | every field marked *amount* above |
| year | 4-digit year | `tax_year` |
| text | as scraped, whitespace-collapsed | everything else |

A date **range** in the source resolves to one endpoint: `billing_date` takes
the **end** of the range (the close of the billing period is the date of
record); every other date field takes the **start**.

Two fields look typed but are not normalised, by design or by omission:

- `date` (utility) is deliberately raw. The utility template buckets it at
  face value, where `billing_date` rolls a pre-15th bill into the previous
  month. That difference is why the Excel importer maps "Invoice Date" to
  `date`, not `billing_date`.
- `cap_rate` has a percent normaliser written for it, but `PERCENT_FIELDS` is
  an empty set, so it passes through as scraped.

## Normalisation happens on both sides, unevenly

Important when calling the backend directly rather than going through the
web app:

| | Frontend (`sanitizeResults`) | Backend (`/api/utility/extract-regions`) |
|---|---|---|
| Dates | all 8 date fields | only `billing_date`, `statement_date`, `appraised_date`, `lease_date`, `lease_begin_date`, `lease_end_date` |
| Amounts | normalised | **not** normalised — raw as scraped |
| Years | `tax_year` normalised | not normalised |

So an API client gets raw amount strings (`$1,151.39`, `1,151.39 USD`) and
raw `tax_bill_date` / `tax_due_date` values. Apply the same shaping on your
side, or the values won't match what the Pexl UI shows for the same document.

## Label synonyms

[`src/lib/field-label-synonyms.ts`](../src/lib/field-label-synonyms.ts) maps
each field key to the label text to search for in a PDF (`account_number` →
"account number", "account no", "account #", "acct no", "acct #"). Useful as
a starting point for header matching in another app.

## Where fields travel

- Extraction request/response: `/api/utility/extract-regions` — regions carry
  `field`; results come back as `{page, field, value, confidence, wasOcr}`.
- Batch storage: `/api/batches/{id}/records` — each record is
  `{session_id, filename, page, fields}` where `fields` is a flat
  `{field_key: value}` JSON object. Unknown keys are stored and returned
  as-is, which is how `*_expr` rides along.
- Excel export picks its template from the batch's `doc_type`, falling back
  to a field-name heuristic when that is NULL.
