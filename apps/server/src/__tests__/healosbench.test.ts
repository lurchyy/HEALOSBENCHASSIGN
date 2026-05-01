import { test, expect } from "bun:test";
import { tokenSetRatio, medsMatch } from "../services/evaluate.service.js";
import { evaluateCase, aggregateF1 } from "../services/evaluate.service.js";
import { buildCachedCaseResultValues, getRemainingTranscriptIds, isRateLimitError, runWithRateLimitRetries } from "../services/run-utils.js";
import { extractClinical, getPromptHash, setAnthropicClientForTesting, validateExtraction } from "@test-evals/llm";
import type { ClinicalExtraction, FieldScores } from "@test-evals/shared";

const VALID_EXTRACTION: ClinicalExtraction = {
  chief_complaint: "headache",
  vitals: { bp: "120/80", hr: 72, temp_f: 98.6, spo2: 99 },
  medications: [{ name: "acetaminophen", dose: "500 mg", frequency: "every 8 hours", route: "PO" }],
  diagnoses: [{ description: "tension headache", icd10: "G44.209" }],
  plan: ["acetaminophen 500 mg every 8 hours", "rest and hydration"],
  follow_up: { interval_days: 7, reason: "reassess symptoms" },
};

const VALID_SCORES: FieldScores = {
  chief_complaint: 1,
  vitals: 1,
  medications: 1,
  diagnoses: 1,
  plan: 1,
  follow_up: 1,
};

// ─── Test 1: Prompt hash stability ────────────────────────────────────────────
test("getPromptHash returns same value on repeated calls for same strategy", () => {
  const hash1 = getPromptHash("zero_shot");
  const hash2 = getPromptHash("zero_shot");
  expect(hash1).toBe(hash2);
  expect(hash1).toHaveLength(64); // SHA-256 hex
});

test("getPromptHash differs across strategies", () => {
  const h1 = getPromptHash("zero_shot");
  const h2 = getPromptHash("few_shot");
  const h3 = getPromptHash("cot");
  expect(h1).not.toBe(h2);
  expect(h1).not.toBe(h3);
  expect(h2).not.toBe(h3);
});

// ─── Test 2: Fuzzy med matching ───────────────────────────────────────────────
test("medsMatch: two meds that should match", () => {
  const a = { name: "ibuprofen", dose: "400mg", frequency: "every 6 hours" };
  const b = { name: "ibuprofen", dose: "400mg", frequency: "every 6 hours" };
  expect(medsMatch(a, b)).toBe(true);
});

test("medsMatch: two meds that should NOT match (different names)", () => {
  const a = { name: "ibuprofen", dose: "400mg", frequency: "every 6 hours" };
  const b = { name: "acetaminophen", dose: "500mg", frequency: "every 8 hours" };
  expect(medsMatch(a, b)).toBe(false);
});

test("medsMatch: BID vs twice daily frequency normalization matches", () => {
  const a = { name: "amoxicillin", dose: "500mg", frequency: "BID" };
  const b = { name: "amoxicillin", dose: "500mg", frequency: "twice daily" };
  expect(medsMatch(a, b)).toBe(true);
});

test("medsMatch: duration qualifiers do not break equivalent schedules", () => {
  const a = { name: "polyethylene glycol", dose: "17 grams", frequency: "once daily for two weeks" };
  const b = { name: "polyethylene glycol", dose: "17 g", frequency: "once daily" };
  expect(medsMatch(a, b)).toBe(true);
});

test("medsMatch: different numeric frequencies do not match", () => {
  const a = { name: "ibuprofen", dose: "600 mg", frequency: "every 6 hours" };
  const b = { name: "ibuprofen", dose: "600 mg", frequency: "every 8 hours" };
  expect(medsMatch(a, b)).toBe(false);
});

// ─── Test 3: Set-F1 correctness ───────────────────────────────────────────────
test("Set-F1: 2 meds predicted, 1 correct → F1 = 0.667", () => {
  const gold: ClinicalExtraction = {
    chief_complaint: "test",
    vitals: { bp: "120/80", hr: 70, temp_f: 98.6, spo2: 99 },
    medications: [{ name: "ibuprofen", dose: "400mg", frequency: "every 6 hours", route: "PO" }],
    diagnoses: [],
    plan: [],
    follow_up: { interval_days: null, reason: null },
  };
  const prediction: ClinicalExtraction = {
    ...gold,
    medications: [
      { name: "ibuprofen", dose: "400mg", frequency: "every 6 hours", route: "PO" },
      { name: "acetaminophen", dose: "500mg", frequency: "every 8 hours", route: "PO" },
    ],
  };
  const { scores } = evaluateCase(prediction, gold, "ibuprofen 400mg every 6 hours test");
  // 1 true positive, 2 predicted, 1 gold → precision=0.5, recall=1, F1=0.667
  expect(scores.medications).toBeCloseTo(0.667, 2);
});

// ─── Test 4: Hallucination detection ─────────────────────────────────────────
test("Hallucination detector: positive case (value not in transcript)", () => {
  const gold: ClinicalExtraction = {
    chief_complaint: "chest pain",
    vitals: { bp: null, hr: null, temp_f: null, spo2: null },
    medications: [],
    diagnoses: [{ description: "myocardial infarction" }],
    plan: [],
    follow_up: { interval_days: null, reason: null },
  };
  const prediction: ClinicalExtraction = {
    ...gold,
    diagnoses: [{ description: "pneumothorax acute tension" }],
  };
  const transcript = "Patient reports chest pain. Doctor notes EKG changes.";
  const { hallucinations } = evaluateCase(prediction, gold, transcript);
  expect(hallucinations.some((h) => h.field === "diagnoses.description")).toBe(true);
});

test("Hallucination detector: negative case (value IS in transcript)", () => {
  const gold: ClinicalExtraction = {
    chief_complaint: "chest pain",
    vitals: { bp: null, hr: null, temp_f: null, spo2: null },
    medications: [],
    diagnoses: [{ description: "chest pain" }],
    plan: [],
    follow_up: { interval_days: null, reason: null },
  };
  const prediction: ClinicalExtraction = { ...gold };
  const transcript = "Patient reports chest pain. Doctor evaluates.";
  const { hallucinations } = evaluateCase(prediction, gold, transcript);
  expect(hallucinations.filter((h) => h.field === "diagnoses.description")).toHaveLength(0);
});

test("Hallucination detector: grounded clinical paraphrases are not flagged", () => {
  const extraction: ClinicalExtraction = {
    chief_complaint: "facial pressure and purulent nasal discharge for ten days",
    vitals: { bp: "118/76", hr: 82, temp_f: 101.2, spo2: 97 },
    medications: [
      { name: "amoxicillin-clavulanate", dose: "875 mg", frequency: "twice daily", route: "PO" },
      { name: "pseudoephedrine", dose: "30 mg", frequency: "every 6 hours", route: "PO" },
    ],
    diagnoses: [{ description: "acute bacterial sinusitis", icd10: "J01.90" }],
    plan: [
      "start amoxicillin-clavulanate 875 mg twice daily for 7 days",
      "saline nasal rinse twice a day",
      "pseudoephedrine 30 mg every 6 hours as needed for congestion",
      "call if not significantly better in 5 days",
    ],
    follow_up: { interval_days: null, reason: "call if not improving in 5 days" },
  };
  const transcript = "Patient has pressure behind eyes and cheeks for ten days with yellow-green stuff coming out my nose. Given duration past 10 days this looks like acute bacterial sinusitis. Start amoxicillin-clavulanate 875 mg twice daily for 7 days. Use a saline rinse twice a day and pseudoephedrine 30 mg every 6 hours for congestion. If not significantly better in 5 days, call us.";

  const { hallucinations } = evaluateCase(extraction, extraction, transcript);

  expect(hallucinations).toHaveLength(0);
});

test("Hallucination detector: unsupported plan action is flagged", () => {
  const gold: ClinicalExtraction = {
    chief_complaint: "cough",
    vitals: { bp: null, hr: null, temp_f: null, spo2: null },
    medications: [],
    diagnoses: [{ description: "viral cough" }],
    plan: ["rest and fluids"],
    follow_up: { interval_days: null, reason: null },
  };
  const prediction: ClinicalExtraction = {
    ...gold,
    plan: ["rest and fluids", "go to the ER for a chest X-ray if cough persists"],
  };
  const transcript = "Patient has a cough. Clinician says this is likely viral. Plan is rest and fluids.";

  const { hallucinations } = evaluateCase(prediction, gold, transcript);

  expect(hallucinations.some((h) => h.field === "plan" && h.value.includes("ER"))).toBe(true);
});

test("Hallucination detector: smoking cessation paraphrase is grounded", () => {
  const gold: ClinicalExtraction = {
    chief_complaint: "smoking cessation counseling",
    vitals: { bp: null, hr: null, temp_f: null, spo2: null },
    medications: [],
    diagnoses: [{ description: "tobacco use disorder" }],
    plan: [],
    follow_up: { interval_days: null, reason: null },
  };
  const prediction: ClinicalExtraction = {
    ...gold,
    chief_complaint: "tobacco use cessation counseling",
  };
  const transcript = "[Visit type: in-person counseling] Patient wants to quit smoking.";

  const { hallucinations } = evaluateCase(prediction, gold, transcript);

  expect(hallucinations).toHaveLength(0);
});

// ─── Test 5: aggregateF1 calculation ─────────────────────────────────────────
test("aggregateF1 is mean of all field scores", () => {
  const scores: FieldScores = {
    chief_complaint: 0.8,
    vitals: 0.6,
    medications: 1.0,
    diagnoses: 0.5,
    plan: 0.7,
    follow_up: 0.9,
  };
  const agg = aggregateF1(scores);
  const expected = (0.8 + 0.6 + 1.0 + 0.5 + 0.7 + 0.9) / 6;
  expect(agg).toBeCloseTo(expected, 5);
});

// ─── Test 6: tokenSetRatio ────────────────────────────────────────────────────
test("tokenSetRatio: identical strings → 1", () => {
  expect(tokenSetRatio("sore throat", "sore throat")).toBe(1);
});

test("tokenSetRatio: completely different strings → low score", () => {
  const score = tokenSetRatio("sore throat", "hypertension");
  expect(score).toBeLessThan(0.2);
});

test("tokenSetRatio: null inputs", () => {
  expect(tokenSetRatio(null, null)).toBe(1);
  expect(tokenSetRatio(null, "something")).toBe(0);
  expect(tokenSetRatio("something", null)).toBe(0);
});

// ─── Test 7: Schema-validation retry path input ──────────────────────────────
test("validateExtraction reports schema issues that feed retry feedback", () => {
  const errors = validateExtraction({
    chief_complaint: "",
    vitals: { bp: null },
    medications: "none",
    diagnoses: [],
    follow_up: {},
  });

  expect(errors).toContain("chief_complaint must be a non-empty string");
  expect(errors).toContain("vitals.hr is required");
  expect(errors).toContain("medications must be an array");
  expect(errors).toContain("plan must be an array");
  expect(errors).toContain("follow_up.interval_days is required");
});

test("extractClinical retries invalid tool input with validation feedback", async () => {
  const calls: unknown[] = [];
  const responses = [
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_invalid",
          name: "record_extraction",
          input: { chief_complaint: "", vitals: {}, medications: [], diagnoses: [], follow_up: {} },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 3 },
    },
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_valid",
          name: "record_extraction",
          input: VALID_EXTRACTION,
        },
      ],
      usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 },
    },
  ];

  setAnthropicClientForTesting({
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        const response = responses.shift();
        if (!response) throw new Error("unexpected extra Anthropic call");
        return response;
      },
    },
  } as never);

  try {
    const result = await extractClinical("Patient reports headache.", "zero_shot", {
      model: "mock-model",
      maxRetries: 3,
    });

    expect(result.extraction).toEqual(VALID_EXTRACTION);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.success).toBe(false);
    expect(result.attempts[0]?.validationErrors).toContain("chief_complaint must be a non-empty string");
    expect(result.attempts[1]?.success).toBe(true);
    expect(result.usage.cache_read_input_tokens).toBe(6);
    expect(result.usage.cache_write_input_tokens).toBe(3);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain("Validation failed with errors");
  } finally {
    setAnthropicClientForTesting(null);
  }
});

// ─── Test 8: Resumability ────────────────────────────────────────────────────
test("getRemainingTranscriptIds skips completed cases when resuming", () => {
  const remaining = getRemainingTranscriptIds(
    ["case_001", "case_002", "case_003", "case_004"],
    new Set(["case_001", "case_003"]),
  );

  expect(remaining).toEqual(["case_002", "case_004"]);
});

// ─── Test 9: Idempotency cached reuse ─────────────────────────────────────────
test("buildCachedCaseResultValues creates a zero-cost completed cached case", () => {
  const cached = {
    id: "old-case",
    runId: "old-run",
    transcriptId: "case_001",
    strategy: "few_shot",
    model: "claude-haiku-4-5-20251001",
    status: "completed",
    prediction: '{"chief_complaint":"headache"}',
    scores: '{"chief_complaint":1}',
    hallucinations: "[]",
    attempts: "[]",
    tokensInput: 123,
    tokensOutput: 45,
    tokensCacheRead: 67,
    tokensCacheWrite: 89,
    costUsd: "0.123456",
    wallTimeMs: 999,
    error: null,
    createdAt: new Date("2026-04-30T00:00:00Z"),
  };

  const values = buildCachedCaseResultValues(cached, "new-case", "new-run");

  expect(values.id).toBe("new-case");
  expect(values.runId).toBe("new-run");
  expect(values.status).toBe("completed");
  expect(values.prediction).toBe(cached.prediction);
  expect(values.tokensInput).toBe(0);
  expect(values.tokensOutput).toBe(0);
  expect(values.costUsd).toBe("0");
});

// ─── Test 10: Rate-limit backoff logic ────────────────────────────────────────
test("rate limit error detection works for 429 messages", () => {
  expect(isRateLimitError(new Error("Error 429: Too Many Requests"))).toBe(true);
  expect(isRateLimitError("rate limit exceeded")).toBe(true);
  expect(isRateLimitError("Network connection error")).toBe(false);
  expect(isRateLimitError("Invalid API key")).toBe(false);
});

test("runWithRateLimitRetries retries 429 errors before succeeding", async () => {
  let calls = 0;
  const sleeps: number[] = [];

  const result = await runWithRateLimitRetries(
    async () => {
      calls++;
      if (calls < 3) throw new Error("429 rate limit exceeded");
      return "ok";
    },
    { maxRetries: 3, delayMs: 25, sleep: async (ms) => { sleeps.push(ms); } },
  );

  expect(result).toBe("ok");
  expect(calls).toBe(3);
  expect(sleeps).toEqual([25, 25]);
});

const dbTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip;

function cachedCaseValues(runId: string, transcriptId: string, strategy = "zero_shot") {
  return {
    id: `case-${runId}-${transcriptId}`,
    runId,
    transcriptId,
    strategy,
    model: "claude-haiku-4-5-20251001",
    status: "completed",
    prediction: JSON.stringify(VALID_EXTRACTION),
    scores: JSON.stringify(VALID_SCORES),
    hallucinations: "[]",
    attempts: "[]",
    tokensInput: 111,
    tokensOutput: 22,
    tokensCacheRead: 33,
    tokensCacheWrite: 44,
    costUsd: "0.001000",
    wallTimeMs: 123,
    error: null,
  };
}

dbTest("DB idempotency reuses a completed matching case without an LLM call", async () => {
  const { eq } = await import("drizzle-orm");
  const { db, runs, caseResults } = await import("@test-evals/db");
  const { createRun, startRun } = await import("../services/runner.service.js");

  const strategy = "zero_shot";
  const model = "claude-haiku-4-5-20251001";
  const sourceRunId = `test-source-${Date.now()}`;
  let newRunId = "";

  try {
    await db.insert(runs).values({
      id: sourceRunId,
      strategy,
      model,
      promptHash: getPromptHash(strategy),
      status: "completed",
      totalCases: 1,
      completedCases: 1,
    });
    await db.insert(caseResults).values(cachedCaseValues(sourceRunId, "case_001", strategy));

    newRunId = await createRun(strategy, model, ["case_001"]);
    await startRun(newRunId, strategy, model, ["case_001"], null);

    const rows = await db.select().from(caseResults).where(eq(caseResults.runId, newRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.tokensInput).toBe(0);
    expect(Number(rows[0]?.costUsd)).toBe(0);
  } finally {
    if (newRunId) {
      await db.delete(caseResults).where(eq(caseResults.runId, newRunId));
      await db.delete(runs).where(eq(runs.id, newRunId));
    }
    await db.delete(caseResults).where(eq(caseResults.runId, sourceRunId));
    await db.delete(runs).where(eq(runs.id, sourceRunId));
  }
});

dbTest("DB resumability skips completed cases and finishes remaining cached cases", async () => {
  const { eq } = await import("drizzle-orm");
  const { db, runs, caseResults } = await import("@test-evals/db");
  const { createRun, resumeRun } = await import("../services/runner.service.js");

  const strategy = "zero_shot";
  const model = "claude-haiku-4-5-20251001";
  const sourceRunId = `test-resume-source-${Date.now()}`;
  let runId = "";

  try {
    await db.insert(runs).values({
      id: sourceRunId,
      strategy,
      model,
      promptHash: getPromptHash(strategy),
      status: "completed",
      totalCases: 1,
      completedCases: 1,
    });
    await db.insert(caseResults).values(cachedCaseValues(sourceRunId, "case_002", strategy));

    runId = await createRun(strategy, model, ["case_001", "case_002"]);
    await db.insert(caseResults).values(cachedCaseValues(runId, "case_001", strategy));

    await resumeRun(runId, null);

    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const rows = await db.select().from(caseResults).where(eq(caseResults.runId, runId));
    expect(runRows[0]?.status).toBe("completed");
    expect(runRows[0]?.totalCases).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.transcriptId === "case_002")?.tokensInput).toBe(0);
  } finally {
    if (runId) {
      await db.delete(caseResults).where(eq(caseResults.runId, runId));
      await db.delete(runs).where(eq(runs.id, runId));
    }
    await db.delete(caseResults).where(eq(caseResults.runId, sourceRunId));
    await db.delete(runs).where(eq(runs.id, sourceRunId));
  }
});
