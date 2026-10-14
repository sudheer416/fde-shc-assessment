# Email to GlobalHealth Corp IT Director

**Subject:** SHC Patient Data Migration — Container Setup and Data Quality Findings

Dear IT Director,

We have prepared a TypeScript-based ingestion pipeline to normalize the legacy patient export and submit the resulting records to the SHC REST API. The pipeline deduplicates records by `patient_id` using the latest `last_modified` timestamp, standardizes dates, converts balances to numeric values, and handles missing contact fields. It submits records in batches of up to 100, respects the five-requests-per-second limit, retries rate-limit and server errors with exponential backoff, and records rejected batches in `failed_records.json` so the remaining batches can continue.

The supplied sample contained inconsistent date formats, missing email/phone values, currency symbols and thousands separators, an unquoted comma that split one balance across CSV columns, and duplicate patient IDs with different update timestamps. Dates are normalized to `YYYY-MM-DD`; missing contacts are represented as `null`; currency values are converted to numbers; the malformed sample balance is repaired when the timestamp column makes the row unambiguous; and the newest record is retained for each patient ID. Rows that cannot be interpreted safely stop normalization with a row-specific error rather than being silently changed.

To build the image, run `docker build -t shc-patient-ingestion:1.0 .`. Put the authorized API endpoint and bearer token in a runtime environment file (do not bake secrets into the image), then run the container with the input directory mounted read-only and an output directory mounted read-write. For example:

```bash
docker run --rm --env-file .env \
  -e INPUT_FILE=/app/data/patients.csv \
  -e FAILED_RECORDS_FILE=/app/output/failed_records.json \
  -v "$PWD/data:/app/data:ro" \
  -v "$PWD/output:/app/output" \
  shc-patient-ingestion:1.0
```

The normalized payload is saved to `output/normalized_patients.json`, and unsuccessful batches are recorded in `output/failed_records.json`. Please confirm the production API's expected JSON payload schema and provide the approved endpoint and credentials before the first live run; the assessment endpoint is a mock address.

For future exports, we recommend enforcing a schema at the source: emit dates in ISO 8601 format, quote CSV fields containing commas, use a consistent currency representation (ideally a plain decimal field plus currency code), and include a stable `last_modified` timestamp with timezone. This will reduce ambiguity, simplify validation, and make future migrations more reliable.

Kind regards,  
Forward Deployed Engineering


**Local testing note:** This submission also includes a small Express-based mock API for local validation. It simulates the expected endpoint contract, bearer authentication, batch-size validation, and rate limiting. It is only a test substitute; production ingestion must use the endpoint and credentials supplied by SHC.
