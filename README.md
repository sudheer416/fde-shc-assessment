# SHC Patient Ingestion Pipeline (TypeScript / Node.js)

A small, containerized ETL pipeline for the SHC FDE technical assessment. It reads a legacy patient CSV, normalizes and deduplicates records, writes a normalized JSON artifact, then posts records to the SHC REST API in fault-tolerant batches.

## Requirements

- Node.js 20+ and npm (local execution)
- Docker (container execution)
- An authorized SHC API bearer token for a real ingestion run

> The assessment endpoint (`https://api.mock-shc.com/v1/patients`) is not assumed to be live. This project now includes a small Express mock API for local integration testing. The default `.env.example` targets that local API; switch `API_URL` and `API_TOKEN` only when a real endpoint and authorized credentials are provided.

## Quick start (local)

```bash
npm install
cp .env.example .env
npm test
npm run build
```

### Run the local mock API and ingestion pipeline

Open terminal 1 and start the Express API:

```bash
npm run dev:mock
```

It listens on `http://localhost:4000`. Open terminal 2 and run the ingestion pipeline:

```bash
npm run dev
```

The `.env.example` defaults to `http://localhost:4000/v1/patients` with the development-only token `local-dev-token`. The mock server implements Bearer authentication, validates batches (1–100 records), enforces a rolling 5-requests-per-second limit, and stores accepted patients in memory. Use `GET http://localhost:4000/health` for health checks and `GET http://localhost:4000/v1/patients` to inspect accepted records. Data is reset whenever the mock server restarts.

To test retry behavior, set `MOCK_FAIL_FIRST_REQUESTS=1` in `.env` before starting the mock API. The first request will return HTTP 500, and the ingestion client should retry successfully. Set it back to `0` for normal runs. The mock server is for development/testing only; it is not the actual SHC API and should not be exposed publicly.

### Run both services with Docker Compose

```bash
mkdir -p output
docker compose up --build --abort-on-container-exit --exit-code-from ingestion ingestion
```

Compose starts the mock API and then runs the ingestion service against `http://mock-api:4000/v1/patients`. The API container is reachable by the service name on the Compose network.

The default input is `./data/patients.csv`. The included file is the assessment's sample data, including its malformed unquoted thousands separator, missing contacts, mixed date formats, and duplicate patient IDs.

Outputs:

- `output/normalized_patients.json` — normalized, deduplicated records before API submission.
- `output/failed_records.json` — batches that could not be ingested, including HTTP 400 batches and exhausted retries. Existing failures are appended to rather than overwritten.

Do not put real patient data or API credentials in source control. The included sample data is only the synthetic data supplied in the assessment.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `API_URL` | `http://localhost:4000/v1/patients` in `.env.example` | API endpoint; use the Compose service URL inside Docker Compose |
| `API_TOKEN` | required | Bearer token; passed through environment, never hard-coded |
| `INPUT_FILE` | `./data/patients.csv` | Source CSV path |
| `FAILED_RECORDS_FILE` | `./output/failed_records.json` | Failed batch log |
| `BATCH_SIZE` | `100` | Records per request; maximum allowed is 100 |
| `MAX_REQUESTS_PER_SECOND` | `5` | Request pacing; maximum allowed is 5 |
| `MAX_RETRIES` | `5` | Number of retries after the initial attempt; configured from 0 to 10 |
| `INITIAL_BACKOFF_MS` | `500` | Base exponential backoff delay |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `MOCK_API_PORT` | `4000` | Local mock API listening port |
| `MOCK_API_TOKEN` | `local-dev-token` | Token expected by the local mock API only |
| `MOCK_MAX_REQUESTS_PER_SECOND` | `5` | Mock API request limit (capped at 5) |
| `MOCK_FAIL_FIRST_REQUESTS` | `0` | Optional number of initial requests to fail for retry testing |
| `MOCK_FAILURE_STATUS` | `500` | Status used for optional mock fault injection |

## Docker

Build the image:

```bash
docker build -t shc-patient-ingestion:1.0 .
```

Run with an environment file and mounted input/output directories:

```bash
mkdir -p output
docker run --rm \
  --env-file .env \
  -e INPUT_FILE=/app/data/patients.csv \
  -e FAILED_RECORDS_FILE=/app/output/failed_records.json \
  -v "$PWD/data:/app/data:ro" \
  -v "$PWD/output:/app/output" \
  shc-patient-ingestion:1.0
```

The image uses a build stage, installs only production dependencies in the runtime stage, and runs as the unprivileged `node` user. The input mount is read-only; the output mount is writable. Supply secrets at runtime rather than copying `.env` into the image.

## Data normalization decisions

1. **CSV parsing:** Uses a CSV parser with relaxed column count so a malformed row can be repaired deliberately. The sample's `1, 250.00` is unquoted and creates an extra field; when the last field looks like the expected ISO timestamp, the two balance fragments are recombined. Other unexpected row lengths fail with a row number instead of being silently misinterpreted.
2. **Dates:** ISO `YYYY-MM-DD` is accepted as-is after calendar validation. Slash dates are interpreted as `MM/DD/YYYY` (the assessment's example convention); non-ISO hyphen dates are interpreted as `DD-MM-YYYY`. All output DOB values are `YYYY-MM-DD`. Ambiguous slash dates rely on this documented convention; the best upstream fix is to export ISO dates.
3. **Missing contacts:** Empty email and phone values become JSON `null`, not empty strings. This preserves the distinction between missing and present values.
4. **Duplicates:** One record per `patient_id` is retained, selecting the greatest parsed `last_modified` timestamp. Timestamps are normalized to UTC ISO strings.
5. **Balances:** Currency symbols and thousands separators are stripped and values become JavaScript numbers. Negative balances are retained.
6. **Invalid data:** A malformed row with unsupported dates, invalid amounts, invalid timestamps, or unexpected field counts stops normalization with a row-specific error. This is intentional fail-fast behavior: silently dropping or guessing at a patient record could corrupt a migration. The source should be corrected and the run retried.

## API reliability and failure handling

- Uses `POST` with `Authorization: Bearer <token>` and JSON content type.
- Splits normalized patients into batches no larger than 100.
- Paces all attempts, including retries, to no more than 5 requests per second.
- Retries HTTP 429 and 5xx responses, plus transient request/network failures, with capped exponential backoff. A valid `Retry-After` header is honored when it requests a longer wait.
- HTTP 400 responses are written to `failed_records.json` with the response body and the associated batch records; processing continues with later batches. Other non-retryable client errors are also recorded. HTTP 401/403 stop the run because continuing would repeatedly submit data with invalid credentials/permissions.
- Exhausted retries are recorded and the process exits with code `2` after processing the remaining batches. Configuration, file, or normalization errors exit with code `1`.

The assessment does not specify the API's exact request schema or response contract beyond the endpoint, authentication, and batch limit. This implementation sends each batch as a JSON array of patient objects. Confirm this payload shape with the real API's OpenAPI/contract before production deployment.

## Tests

```bash
npm test
```

Tests cover date normalization, currency parsing, malformed CSV repair, missing contact values, newest-record deduplication, retry after a 503, and logging a 400 batch while continuing with the next batch. API tests use mocked responses and do not send patient data to an external service.

## Suggested upstream improvement

Have the legacy export emit a schema-validated CSV with ISO-8601 dates (`YYYY-MM-DD`), properly quoted currency values containing commas, and a documented stable timezone for `last_modified`. Prefer an explicit empty value for missing contact details and enforce unique patient IDs or publish a clear versioning rule.
