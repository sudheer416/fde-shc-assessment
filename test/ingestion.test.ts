import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPatients } from '../src/ingestion.js';
import type { Patient, PipelineConfig } from '../src/types.js';

const patient = (id: string): Patient => ({
  patient_id: id, first_name: 'Test', last_name: 'Patient', dob: '2000-01-01',
  email: null, phone: null, account_balance: 10, last_modified: '2026-01-01T00:00:00.000Z'
});

const baseConfig = (failedRecordsFile: string): PipelineConfig => ({
  apiUrl: 'https://example.invalid/patients', apiToken: 'test-token', inputFile: '',
  failedRecordsFile, batchSize: 100, maxRequestsPerSecond: 5, maxRetries: 2,
  initialBackoffMs: 1, requestTimeoutMs: 1000
});

test('retries 503 and succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fde-test-'));
  let calls = 0;
  try {
    const summary = await ingestPatients([patient('P-1')], baseConfig(join(dir, 'failed.json')), async () => {
      calls += 1;
      return new Response(calls === 1 ? 'temporary failure' : '{}', { status: calls === 1 ? 503 : 200 });
    });
    assert.equal(calls, 2);
    assert.equal(summary.successfulBatches, 1);
    assert.equal(summary.failedBatches, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('logs a 400 batch and continues processing subsequent batches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fde-test-'));
  let calls = 0;
  try {
    const config = { ...baseConfig(join(dir, 'failed.json')), batchSize: 1, maxRequestsPerSecond: 5 };
    const summary = await ingestPatients([patient('P-1'), patient('P-2')], config, async () => {
      calls += 1;
      return new Response(calls === 1 ? 'invalid patient' : '{}', { status: calls === 1 ? 400 : 200 });
    });
    assert.equal(calls, 2);
    assert.equal(summary.successfulBatches, 1);
    assert.equal(summary.failedBatches, 1);
    const failed = JSON.parse(await readFile(config.failedRecordsFile, 'utf8')) as Array<{ status: number; records: Patient[] }>;
    assert.equal(failed[0].status, 400);
    assert.equal(failed[0].records[0].patient_id, 'P-1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
