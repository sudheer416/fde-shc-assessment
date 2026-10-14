export interface Patient {
  patient_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  email: string | null;
  phone: string | null;
  account_balance: number;
  last_modified: string;
}

export interface FailedBatch {
  timestamp: string;
  batchIndex: number;
  status: number | null;
  reason: string;
  error: string;
  records: Patient[];
}

export interface PipelineConfig {
  apiUrl: string;
  apiToken: string;
  inputFile: string;
  failedRecordsFile: string;
  batchSize: number;
  maxRequestsPerSecond: number;
  maxRetries: number;
  initialBackoffMs: number;
  requestTimeoutMs: number;
}
