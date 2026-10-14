import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseAndNormalizeCsv } from './normalizer.js';
import { ingestPatients, readInputFile } from './ingestion.js';
import type { PipelineConfig } from './types.js';

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function loadConfig(): PipelineConfig {
  const apiUrl = process.env.API_URL?.trim() || 'https://api.mock-shc.com/v1/patients';
  const apiToken = process.env.API_TOKEN?.trim() || '';
  const inputFile = process.env.INPUT_FILE?.trim() || './data/patients.csv';
  const failedRecordsFile = process.env.FAILED_RECORDS_FILE?.trim() || './output/failed_records.json';
  const batchSize = positiveInteger('BATCH_SIZE', 100);
  const maxRequestsPerSecond = positiveInteger('MAX_REQUESTS_PER_SECOND', 5);
  const maxRetries = Number(process.env.MAX_RETRIES ?? 5);
  const initialBackoffMs = positiveInteger('INITIAL_BACKOFF_MS', 500);
  const requestTimeoutMs = positiveInteger('REQUEST_TIMEOUT_MS', 30_000);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error('MAX_RETRIES must be an integer from 0 to 10.');
  return { apiUrl, apiToken, inputFile, failedRecordsFile, batchSize, maxRequestsPerSecond, maxRetries, initialBackoffMs, requestTimeoutMs };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.apiToken) throw new Error('API_TOKEN is missing. Copy .env.example to .env and set your authorized token.');
  if (config.batchSize > 100) throw new Error('BATCH_SIZE cannot exceed the API limit of 100.');
  if (config.maxRequestsPerSecond > 5) throw new Error('MAX_REQUESTS_PER_SECOND cannot exceed the API limit of 5.');

  const csvText = await readInputFile(config.inputFile);
  const patients = parseAndNormalizeCsv(csvText);
  const normalizedPath = resolve('./output/normalized_patients.json');
  await mkdir(dirname(normalizedPath), { recursive: true });
  await writeFile(normalizedPath, `${JSON.stringify(patients, null, 2)}\n`, 'utf8');
  console.info(`Normalization complete: ${patients.length} unique patients from ${config.inputFile}.`);
  console.info(`Normalized preview/output saved to ${normalizedPath}.`);

  const summary = await ingestPatients(patients, config);
  console.info('Pipeline summary:', JSON.stringify(summary, null, 2));
  if (summary.failedBatches > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error('Pipeline stopped:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
