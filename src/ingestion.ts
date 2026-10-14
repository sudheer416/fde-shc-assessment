import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FailedBatch, Patient, PipelineConfig } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

class RequestPacer {
  private lastRequestAt = 0;
  constructor(private readonly maxRequestsPerSecond: number) {}
  async wait(): Promise<void> {
    const intervalMs = 1000 / this.maxRequestsPerSecond;
    const delay = Math.max(0, this.lastRequestAt + intervalMs - Date.now());
    if (delay > 0) await sleep(delay);
    this.lastRequestAt = Date.now();
  }
}

async function responseBody(response: Response): Promise<string> {
  const body = await response.text();
  return body.length > 4000 ? `${body.slice(0, 4000)}…[truncated]` : body;
}

async function appendFailures(filePath: string, failures: FailedBatch[]): Promise<void> {
  if (failures.length === 0) return;
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  let existing: FailedBatch[] = [];
  try {
    const content = await readFile(absolute, 'utf8');
    existing = JSON.parse(content) as FailedBatch[];
    if (!Array.isArray(existing)) existing = [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(absolute, `${JSON.stringify([...existing, ...failures], null, 2)}\n`, 'utf8');
}

export interface IngestionSummary {
  totalRecords: number;
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
}

export async function ingestPatients(
  patients: Patient[],
  config: PipelineConfig,
  fetchImpl: typeof fetch = fetch
): Promise<IngestionSummary> {
  if (!config.apiToken.trim()) throw new Error('API_TOKEN is required. Set it in the environment; do not hard-code credentials.');
  if (config.batchSize < 1 || config.batchSize > 100) throw new Error('BATCH_SIZE must be between 1 and 100.');
  if (config.maxRequestsPerSecond <= 0 || config.maxRequestsPerSecond > 5) throw new Error('MAX_REQUESTS_PER_SECOND must be between 0 and 5.');

  const batches: Patient[][] = [];
  for (let i = 0; i < patients.length; i += config.batchSize) batches.push(patients.slice(i, i + config.batchSize));
  const pacer = new RequestPacer(config.maxRequestsPerSecond);
  const failures: FailedBatch[] = [];
  let successfulBatches = 0;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    let succeeded = false;
    let lastStatus: number | null = null;
    let lastError = '';

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      await pacer.wait();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      let retryAfterMs: number | null = null;
      try {
        const response = await fetchImpl(config.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(batch),
          signal: controller.signal
        });
        lastStatus = response.status;
        if (response.ok) {
          succeeded = true;
          console.info(`Batch ${index + 1}/${batches.length}: accepted (${batch.length} records, HTTP ${response.status}).`);
          break;
        }

        lastError = await responseBody(response);
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          if (response.status === 401 || response.status === 403) {
            throw new Error(`API authentication/authorization failed (HTTP ${response.status}). Check API_TOKEN and permissions. Response: ${lastError}`);
          }
          break;
        }
        if (attempt < config.maxRetries) {
          const backoff = Math.min(config.initialBackoffMs * (2 ** attempt), 30_000);
          const delay = retryAfterMs === null ? backoff : Math.max(backoff, retryAfterMs);
          console.warn(`Batch ${index + 1}: HTTP ${response.status}; retry ${attempt + 1}/${config.maxRetries} in ${delay}ms.`);
          await sleep(delay);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('API authentication/authorization failed')) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        lastStatus = null;
        if (attempt < config.maxRetries) {
          const delay = Math.min(config.initialBackoffMs * (2 ** attempt), 30_000);
          console.warn(`Batch ${index + 1}: request error; retry ${attempt + 1}/${config.maxRetries} in ${delay}ms (${lastError}).`);
          await sleep(delay);
        }
      } finally {
        clearTimeout(timeout);
      }

      if (lastStatus !== null && lastStatus !== 429 && lastStatus < 500) break;
    }

    if (succeeded) {
      successfulBatches += 1;
    } else {
      const reason = lastStatus === 400 ? 'bad_request' : lastStatus === 429 ? 'rate_limited_retries_exhausted' : (lastStatus !== null && lastStatus >= 500) ? 'server_error_retries_exhausted' : 'request_failed';
      failures.push({
        timestamp: new Date().toISOString(),
        batchIndex: index + 1,
        status: lastStatus,
        reason,
        error: lastError || 'Request failed without a response body.',
        records: batch
      });
      console.error(`Batch ${index + 1}/${batches.length}: failed (${reason}); continuing with the next batch.`);
    }
  }

  await appendFailures(config.failedRecordsFile, failures);
  return {
    totalRecords: patients.length,
    totalBatches: batches.length,
    successfulBatches,
    failedBatches: failures.length
  };
}

export async function readInputFile(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8');
}
