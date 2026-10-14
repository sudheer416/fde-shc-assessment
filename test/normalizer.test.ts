import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDob, parseCurrency, parseAndNormalizeCsv } from '../src/normalizer.js';

const sample = `patient_id,first_name,last_name,dob,email,phone,account_balance,last_modified
P-1001,John,Doe,1980-05-15,john.doe@email.com,555-0100,$150.50,2026-09-28T08:00:00Z
P-1002,Jane,Smith,12/31/1992,,,1, 250.00,2026-10-02T11:30:00Z
P-1003,Alice,Jones,25-04-1975,alice.j@email.com,555-0102,€300.00,2026-10-03T09:15:00Z
P-1001,John,Doe,1980-05-15,john.doe@newemail.com,555-0100,0.00,2026-10-05T14:20:00Z
P-1004,Bob,Brown,1960-11-02,bob.b@email.com,555-0103,"2,450.75",2026-10-01T10:00:00Z
P-1005,Charlie,Davis,07/04/1988,,555-0104,$0.00,2026-10-01T10:00:00Z
P-1006,Diana,Prince,1985-08-20,diana.p@email.com,,$45.50,2026-09-15T08:00:00Z
P-1003,Alice,Jones,04/25/1975,alice.j@email.com,555-0102,$300.00,2026-09-20T10:00:00Z
P-1007,Evan,Wright,15-08-1999,evan.w@email.com,555-0105,$-15.00,2026-10-06T16:45:00Z`;

test('normalizes ISO, slash MM/DD/YYYY, and hyphen DD-MM-YYYY dates', () => {
  assert.equal(normalizeDob('1980-05-15'), '1980-05-15');
  assert.equal(normalizeDob('12/31/1992'), '1992-12-31');
  assert.equal(normalizeDob('25-04-1975'), '1975-04-25');
  assert.throws(() => normalizeDob('31/31/1992'), /Invalid calendar date/);
});

test('parses currency symbols, thousands separators, and negative balances', () => {
  assert.equal(parseCurrency('$150.50'), 150.5);
  assert.equal(parseCurrency('€300.00'), 300);
  assert.equal(parseCurrency('2,450.75'), 2450.75);
  assert.equal(parseCurrency('$-15.00'), -15);
});

test('repairs malformed comma, converts missing contacts to null, and keeps newest duplicate', () => {
  const patients = parseAndNormalizeCsv(sample);
  assert.equal(patients.length, 7);
  const jane = patients.find((p) => p.patient_id === 'P-1002');
  assert.ok(jane);
  assert.equal(jane.account_balance, 1250);
  assert.equal(jane.email, null);
  assert.equal(jane.phone, null);
  const john = patients.find((p) => p.patient_id === 'P-1001');
  assert.ok(john);
  assert.equal(john.email, 'john.doe@newemail.com');
  assert.equal(john.last_modified, '2026-10-05T14:20:00.000Z');
  const alice = patients.find((p) => p.patient_id === 'P-1003');
  assert.ok(alice);
  assert.equal(alice.last_modified, '2026-10-03T09:15:00.000Z');
  assert.equal(patients.find((p) => p.patient_id === 'P-1007')?.account_balance, -15);
});
