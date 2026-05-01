import { nanoid } from "nanoid";
import { desc, eq, and } from "drizzle-orm";
import { db } from "@test-evals/db";
import { runs, caseResults } from "@test-evals/db";
import type { ExtractionStrategy } from "@test-evals/shared";
import { getPromptHash } from "@test-evals/llm";
import { loadTranscript, loadGold } from "./dataset.service.js";
import { extract } from "./extract.service.js";
import { evaluateCase } from "./evaluate.service.js";
import { buildCachedCaseResultValues, getRemainingTranscriptIds, runWithRateLimitRetries } from "./run-utils.js";

const HAIKU_INPUT_COST = 0.00000025; // $0.25 per 1M tokens
const HAIKU_OUTPUT_COST = 0.00000125; // $1.25 per 1M tokens
const HAIKU_CACHE_WRITE_COST = 0.0000003; // $0.30 per 1M tokens
const HAIKU_CACHE_READ_COST = 0.000000025; // $0.025 per 1M tokens

const COST_CAP_USD = parseFloat(process.env.COST_CAP_USD ?? "1.0");
const EVAL_CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY ?? "3", 10);

function computeCost(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
}): number {
  return (
    usage.input_tokens * HAIKU_INPUT_COST +
    usage.output_tokens * HAIKU_OUTPUT_COST +
    usage.cache_write_input_tokens * HAIKU_CACHE_WRITE_COST +
    usage.cache_read_input_tokens * HAIKU_CACHE_READ_COST
  );
}

// Worst-case estimate (no caching): transcript chars / 4 tokens + 1200 overhead (system + tool def).
// Output fixed at 900 tokens (conservative for a full extraction).
function estimateCaseCost(transcript: string): number {
  const inputTokens = Math.ceil(transcript.length / 4) + 1200;
  const outputTokens = 900;
  return inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;
}

function estimateRunCost(transcripts: string[]): number {
  return transcripts.reduce((sum, t) => sum + estimateCaseCost(t), 0);
}

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export type SSEController = {
  write: (data: string) => void;
} | null;

async function refreshRunAggregates(runId: string): Promise<void> {
  const allResults = await db
    .select()
    .from(caseResults)
    .where(eq(caseResults.runId, runId));

  const completed = allResults.filter((r) => r.status === "completed");
  const failed = allResults.filter((r) => r.status === "failed");
  let totalHallucinations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let f1Sum = 0;

  for (const r of completed) {
    const s = r.scores ? (JSON.parse(r.scores) as Record<string, number>) : null;
    if (s) {
      f1Sum += Object.values(s).reduce((a: number, b: number) => a + b, 0) / Object.values(s).length;
    }
    const h = r.hallucinations ? (JSON.parse(r.hallucinations) as unknown[]) : [];
    totalHallucinations += h.length;
    totalInputTokens += r.tokensInput;
    totalOutputTokens += r.tokensOutput;
    totalCacheRead += r.tokensCacheRead;
    totalCacheWrite += r.tokensCacheWrite;
    totalCost += Number(r.costUsd);
  }

  const aggF1 = completed.length > 0 ? f1Sum / completed.length : null;

  await db
    .update(runs)
    .set({
      completedCases: completed.length,
      failedCases: failed.length,
      hallucinationCount: totalHallucinations,
      schemaFailureCount: failed.length,
      totalTokensInput: totalInputTokens,
      totalTokensOutput: totalOutputTokens,
      totalTokensCacheRead: totalCacheRead,
      totalTokensCacheWrite: totalCacheWrite,
      totalCostUsd: String(totalCost),
      aggregateF1: aggF1 !== null ? String(aggF1) : null,
      updatedAt: new Date(),
    })
    .where(eq(runs.id, runId));
}

async function processCase(
  runId: string,
  transcriptId: string,
  strategy: ExtractionStrategy,
  model: string,
  sseController: SSEController,
  force: boolean,
): Promise<void> {
  // Check idempotency
  const existing = await db
    .select()
    .from(caseResults)
    .where(and(eq(caseResults.runId, runId), eq(caseResults.transcriptId, transcriptId)))
    .limit(1);

  const existingRecord = existing[0];
  if (existingRecord && existingRecord.status === "completed") {
    return;
  }

  const caseId = existingRecord ? existingRecord.id : nanoid();
  const promptHash = getPromptHash(strategy);

  if (!force) {
    const [cached] = await db
      .select({ caseResult: caseResults })
      .from(caseResults)
      .innerJoin(runs, eq(caseResults.runId, runs.id))
      .where(
        and(
          eq(caseResults.transcriptId, transcriptId),
          eq(caseResults.strategy, strategy),
          eq(caseResults.model, model),
          eq(caseResults.status, "completed"),
          eq(runs.promptHash, promptHash),
        ),
      )
      .orderBy(desc(caseResults.createdAt))
      .limit(1);

    if (cached) {
      const values = buildCachedCaseResultValues(cached.caseResult, caseId, runId);
      if (!existingRecord) {
        await db.insert(caseResults).values(values);
      } else {
        await db.update(caseResults).set(values).where(eq(caseResults.id, caseId));
      }
      await refreshRunAggregates(runId);
      return;
    }
  }

  if (!existingRecord) {
    await db.insert(caseResults).values({
      id: caseId,
      runId,
      transcriptId,
      strategy,
      model,
      status: "running",
    });
  } else {
    await db
      .update(caseResults)
      .set({ status: "running" })
      .where(eq(caseResults.id, caseId));
  }

  const startTime = Date.now();

  while (true) {
    try {
      const transcript = loadTranscript(transcriptId);
      const gold = loadGold(transcriptId);

      // Cost cap check: read accumulated run cost + estimated case cost before calling API.
      const [runRow] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      const accumulatedCost = Number(runRow?.totalCostUsd ?? 0);
      const estimatedCase = estimateCaseCost(transcript);
      if (accumulatedCost + estimatedCase > COST_CAP_USD) {
        await db
          .update(caseResults)
          .set({ status: "failed", error: `cost cap of $${COST_CAP_USD} would be exceeded (accumulated: $${accumulatedCost.toFixed(6)}, estimated this case: $${estimatedCase.toFixed(6)})`, wallTimeMs: 0 })
          .where(eq(caseResults.id, caseId));
        return;
      }

      const { extraction, attempts, usage } = await runWithRateLimitRetries(
        () => extract(transcript, strategy, model, { maxRetries: 3 }),
        { maxRetries: 3, delayMs: 10000 },
      );

      const { scores, hallucinations } = evaluateCase(extraction, gold, transcript);
      const wallTimeMs = Date.now() - startTime;
      const cost = computeCost(usage);

      await db
        .update(caseResults)
        .set({
          status: "completed",
          prediction: JSON.stringify(extraction),
          scores: JSON.stringify(scores),
          hallucinations: JSON.stringify(hallucinations),
          attempts: JSON.stringify(attempts),
          tokensInput: usage.input_tokens,
          tokensOutput: usage.output_tokens,
          tokensCacheRead: usage.cache_read_input_tokens,
          tokensCacheWrite: usage.cache_write_input_tokens,
          costUsd: String(cost),
          wallTimeMs,
          error: null,
        })
        .where(eq(caseResults.id, caseId));

      await refreshRunAggregates(runId);

      if (sseController) {
        const runData = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
        const runRow = runData[0];
        sseController.write(
          JSON.stringify({
            type: "case_complete",
            transcriptId,
            scores,
            runProgress: {
              completed: runRow?.completedCases ?? 0,
              failed: runRow?.failedCases ?? 0,
              total: runRow?.totalCases ?? 0,
            },
          }),
        );
      }

      return;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      await db
        .update(caseResults)
        .set({
          status: "failed",
          error: errMsg,
          wallTimeMs: Date.now() - startTime,
        })
        .where(eq(caseResults.id, caseId));

      await db
        .update(runs)
        .set({ updatedAt: new Date() })
        .where(eq(runs.id, runId));

      return;
    }
  }
}

export async function startRun(
  runId: string,
  strategy: ExtractionStrategy,
  model: string,
  transcriptIds: string[],
  sseController: SSEController,
  options?: { force?: boolean; totalCases?: number },
): Promise<void> {
  const transcripts = transcriptIds.map((id) => loadTranscript(id));
  const projectedCost = estimateRunCost(transcripts);
  if (projectedCost > COST_CAP_USD) {
    await db
      .update(runs)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(runs.id, runId));
    throw new Error(`Projected run cost $${projectedCost.toFixed(4)} exceeds cap of $${COST_CAP_USD}. Refusing to start.`);
  }

  await db
    .update(runs)
    .set({ status: "running", totalCases: options?.totalCases ?? transcriptIds.length, updatedAt: new Date() })
    .where(eq(runs.id, runId));

  const semaphore = new Semaphore(EVAL_CONCURRENCY);
  const runStart = Date.now();

  const tasks = transcriptIds.map(async (transcriptId) => {
    await semaphore.acquire();
    try {
      await processCase(runId, transcriptId, strategy, model, sseController, options?.force ?? false);
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(tasks);

  const allResults = await db.select().from(caseResults).where(eq(caseResults.runId, runId));
  const completed = allResults.filter((r) => r.status === "completed");
  const failed = allResults.filter((r) => r.status === "failed");
  const totalCases = options?.totalCases ?? transcriptIds.length;
  const allDone = completed.length + failed.length === totalCases;
  const status = failed.length === transcriptIds.length ? "failed" : allDone ? "completed" : "partial";

  const wallTimeMs = Date.now() - runStart;

  await db
    .update(runs)
    .set({
      status,
      wallTimeMs,
      updatedAt: new Date(),
    })
    .where(eq(runs.id, runId));

  if (sseController) {
    const runData = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    const run = runData[0];
    sseController.write(
      JSON.stringify({
        type: "run_complete",
        runId,
        aggregateF1: run?.aggregateF1 !== null ? Number(run?.aggregateF1) : null,
        cost: Number(run?.totalCostUsd ?? 0),
      }),
    );
  }
}

export async function resumeRun(runId: string, sseController: SSEController): Promise<void> {
  const runData = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const run = runData[0];
  if (!run) throw new Error(`Run ${runId} not found`);

  const completedResults = await db
    .select()
    .from(caseResults)
    .where(and(eq(caseResults.runId, runId), eq(caseResults.status, "completed")));
  const completedIds = new Set(completedResults.map((r) => r.transcriptId));

  const allIds = run.datasetFilter
    ? (JSON.parse(run.datasetFilter) as string[])
    : (await import("./dataset.service.js")).listTranscriptIds();

  const remainingIds = getRemainingTranscriptIds(allIds, completedIds);
  if (remainingIds.length === 0) return;

  await startRun(runId, run.strategy as ExtractionStrategy, run.model, remainingIds, sseController, {
    totalCases: allIds.length,
  });
}

export async function createRun(
  strategy: ExtractionStrategy,
  model: string,
  datasetFilter: string[] | null,
): Promise<string> {
  const runId = nanoid();
  const promptHash = getPromptHash(strategy);
  const allIds = datasetFilter ?? (await import("./dataset.service.js")).listTranscriptIds();

  await db.insert(runs).values({
    id: runId,
    strategy,
    model,
    promptHash,
    status: "pending",
    datasetFilter: datasetFilter ? JSON.stringify(datasetFilter) : null,
    totalCases: allIds.length,
  });

  return runId;
}
