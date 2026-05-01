// ClinicalExtraction matches data/schema.json exactly
export interface Medication {
  name: string;
  dose: string | null;
  frequency: string | null;
  route: string | null;
}

export interface Diagnosis {
  description: string;
  icd10?: string;
}

export interface Vitals {
  bp: string | null;
  hr: number | null;
  temp_f: number | null;
  spo2: number | null;
}

export interface FollowUp {
  interval_days: number | null;
  reason: string | null;
}

export interface ClinicalExtraction {
  chief_complaint: string;
  vitals: Vitals;
  medications: Medication[];
  diagnoses: Diagnosis[];
  plan: string[];
  follow_up: FollowUp;
}

export type ExtractionStrategy = "zero_shot" | "few_shot" | "cot";

export type RunStatus = "pending" | "running" | "completed" | "failed" | "partial";

export interface FieldScores {
  chief_complaint: number;
  vitals: number;
  medications: number;
  diagnoses: number;
  plan: number;
  follow_up: number;
}

export interface HallucinationFlag {
  field: string;
  value: string;
}

export interface AttemptLog {
  attempt: number;
  rawResponse: string;
  validationErrors: string[] | null;
  success: boolean;
}

export interface CaseResult {
  id: string;
  runId: string;
  transcriptId: string;
  strategy: ExtractionStrategy;
  model: string;
  status: "pending" | "running" | "completed" | "failed";
  transcript?: string;
  gold?: ClinicalExtraction;
  prediction: ClinicalExtraction | null;
  scores: FieldScores | null;
  hallucinations: HallucinationFlag[];
  attempts: AttemptLog[];
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  wallTimeMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface RunResult {
  id: string;
  strategy: ExtractionStrategy;
  model: string;
  promptHash: string;
  status: RunStatus;
  datasetFilter: string[] | null;
  totalCases: number;
  completedCases: number;
  failedCases: number;
  hallucinationCount: number;
  schemaFailureCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokensCacheRead: number;
  totalTokensCacheWrite: number;
  totalCostUsd: number;
  wallTimeMs: number | null;
  aggregateF1: number | null;
  createdAt: string;
  updatedAt: string;
  cases: CaseResult[];
}

export interface RunSummary {
  id: string;
  strategy: ExtractionStrategy;
  model: string;
  status: RunStatus;
  aggregateF1: number | null;
  totalCostUsd: number;
  totalTokensCacheRead: number;
  totalTokensCacheWrite: number;
  wallTimeMs: number | null;
  totalCases: number;
  completedCases: number;
  createdAt: string;
}
