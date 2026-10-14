import { parse } from 'csv-parse/sync';
import type { Patient } from './types.js';

const EXPECTED_HEADERS = [
  'patient_id', 'first_name', 'last_name', 'dob', 'email', 'phone',
  'account_balance', 'last_modified'
];

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parse the documented source formats without relying on locale-dependent Date parsing. */
export function normalizeDob(raw: string): string {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  let match: RegExpMatchArray | null;

  if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    // Slash-separated dates are interpreted as MM/DD/YYYY, as in the assessment examples.
    month = Number(match[1]); day = Number(match[2]); year = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) {
    // Non-ISO hyphen-separated dates are interpreted as DD-MM-YYYY.
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else {
    throw new Error(`Unsupported date format: "${raw}"`);
  }

  if (!isValidCalendarDate(year, month, day)) throw new Error(`Invalid calendar date: "${raw}"`);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function parseCurrency(raw: string): number {
  const value = raw.trim();
  if (!value) throw new Error('account_balance is empty');
  // Strip currency symbols, whitespace, and thousands separators; preserve minus sign and decimal point.
  const numeric = value.replace(/[\s,$€£₹]/g, '').replace(/[^0-9.-]/g, '');
  if (!numeric || !/^-?\d+(\.\d+)?$/.test(numeric)) {
    throw new Error(`Invalid account_balance: "${raw}"`);
  }
  const result = Number(numeric);
  if (!Number.isFinite(result)) throw new Error(`Invalid account_balance: "${raw}"`);
  return result;
}

function cleanNullable(value: string | undefined): string | null {
  const cleaned = value?.trim() ?? '';
  return cleaned.length ? cleaned : null;
}

function normalizeTimestamp(raw: string): string {
  const value = raw.trim();
  const parsed = Date.parse(value);
  if (!value || Number.isNaN(parsed)) throw new Error(`Invalid last_modified timestamp: "${raw}"`);
  return new Date(parsed).toISOString();
}

/**
 * Parse CSV rows as arrays so we can repair the assessment's malformed unquoted value
 * `1, 250.00`, which otherwise shifts last_modified into the wrong column.
 */
export function parseAndNormalizeCsv(csvText: string): Patient[] {
  const rows = parse(csvText, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
    record_delimiter: ['\r\n', '\n', '\r']
  }) as string[][];

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  if (EXPECTED_HEADERS.some((header, index) => headers[index] !== header) || headers.length !== EXPECTED_HEADERS.length) {
    throw new Error(`CSV headers must be exactly: ${EXPECTED_HEADERS.join(',')}`);
  }

  const byId = new Map<string, Patient>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    let row = rows[rowIndex].map((cell) => cell ?? '');

    // Repair one extra field when an unquoted thousands separator split account_balance.
    if (row.length === EXPECTED_HEADERS.length + 1 && /^\d{4}-\d{2}-\d{2}T/.test(row[row.length - 1]?.trim() ?? '')) {
      row = [...row.slice(0, 6), `${row[6]},${row[7]}`, ...row.slice(8)];
    }
    if (row.length !== EXPECTED_HEADERS.length) {
      throw new Error(`CSV row ${rowIndex + 1} has ${row.length} fields; expected ${EXPECTED_HEADERS.length}. Check quoting and commas.`);
    }

    const record = Object.fromEntries(EXPECTED_HEADERS.map((header, index) => [header, row[index]?.trim() ?? ''])) as Record<string, string>;
    if (!record.patient_id) throw new Error(`CSV row ${rowIndex + 1} is missing patient_id`);

    let patient: Patient;
    try {
      patient = {
        patient_id: record.patient_id,
        first_name: record.first_name,
        last_name: record.last_name,
        dob: normalizeDob(record.dob),
        email: cleanNullable(record.email),
        phone: cleanNullable(record.phone),
        account_balance: parseCurrency(record.account_balance),
        last_modified: normalizeTimestamp(record.last_modified)
      };
    } catch (error) {
      throw new Error(`CSV row ${rowIndex + 1} (patient_id=${record.patient_id}): ${(error as Error).message}`);
    }

    const existing = byId.get(patient.patient_id);
    if (!existing || Date.parse(patient.last_modified) > Date.parse(existing.last_modified)) {
      byId.set(patient.patient_id, patient);
    }
  }

  return [...byId.values()].sort((a, b) => a.patient_id.localeCompare(b.patient_id));
}
