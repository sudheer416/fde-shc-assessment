import express, { type NextFunction, type Request, type Response } from 'express';
import 'dotenv/config';
import type { Patient } from './types.js';

const app = express();
const port = Number(process.env.MOCK_API_PORT ?? 4000);
const expectedToken = process.env.MOCK_API_TOKEN ?? 'local-dev-token';
const maxRequestsPerSecond = Math.min(5, Math.max(1, Number(process.env.MOCK_MAX_REQUESTS_PER_SECOND ?? 5)));
const failFirstRequests = Math.max(0, Number(process.env.MOCK_FAIL_FIRST_REQUESTS ?? 0));
const failureStatus = Number(process.env.MOCK_FAILURE_STATUS ?? 500);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const acceptedPatients = new Map<string, Patient>();
const requestTimes: number[] = [];
let totalRequests = 0;
let simulatedFailures = 0;

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'local-shc-mock-api' });
});

app.get('/v1/patients', (_req: Request, res: Response) => {
  res.json({ count: acceptedPatients.size, patients: [...acceptedPatients.values()] });
});

app.post('/v1/patients', (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('authorization');
  if (authHeader !== `Bearer ${expectedToken}`) {
    res.status(401).json({ error: 'Unauthorized', message: 'Send a valid Bearer token.' });
    return;
  }

  const now = Date.now();
  while (requestTimes.length > 0 && now - requestTimes[0] >= 1000) requestTimes.shift();
  if (requestTimes.length >= maxRequestsPerSecond) {
    res.setHeader('Retry-After', '1');
    res.status(429).json({ error: 'Too Many Requests', message: `Limit is ${maxRequestsPerSecond} requests per second.` });
    return;
  }
  requestTimes.push(now);
  totalRequests += 1;

  // Optional deterministic fault injection for local retry testing only.
  if (simulatedFailures < failFirstRequests) {
    simulatedFailures += 1;
    res.status(failureStatus).json({ error: 'Simulated upstream failure', attempt: simulatedFailures });
    return;
  }

  if (!Array.isArray(req.body)) {
    res.status(400).json({ error: 'Bad Request', message: 'Request body must be an array of patient records.' });
    return;
  }
  if (req.body.length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Batch must contain at least one patient.' });
    return;
  }
  if (req.body.length > 100) {
    res.status(400).json({ error: 'Bad Request', message: 'A batch cannot contain more than 100 records.' });
    return;
  }

  const patients = req.body as Partial<Patient>[];
  const invalidIndex = patients.findIndex((patient) =>
    !patient || typeof patient.patient_id !== 'string' || !patient.patient_id.trim() ||
    typeof patient.dob !== 'string' || typeof patient.account_balance !== 'number' ||
    !Number.isFinite(patient.account_balance) || typeof patient.last_modified !== 'string'
  );
  if (invalidIndex >= 0) {
    res.status(400).json({ error: 'Bad Request', message: `Invalid patient record at batch index ${invalidIndex}.` });
    return;
  }

  for (const patient of patients as Patient[]) acceptedPatients.set(patient.patient_id, patient);
  res.status(201).json({ accepted: patients.length, totalUniquePatients: acceptedPatients.size });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'Bad Request', message: 'Request body contains invalid JSON.' });
    return;
  }
  console.error('Mock API error:', error);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(port, '0.0.0.0', () => {
  console.info(`Local SHC mock API listening on http://localhost:${port}`);
  console.info(`POST endpoint: http://localhost:${port}/v1/patients`);
  console.info(`Bearer token configured: ${expectedToken ? 'yes' : 'no'}`);
  if (failFirstRequests > 0) console.info(`Fault injection enabled: first ${failFirstRequests} request(s) return HTTP ${failureStatus}.`);
  console.info('Use GET /health for health checks and GET /v1/patients to inspect accepted records.');
});

process.on('SIGTERM', () => process.exit(0));
