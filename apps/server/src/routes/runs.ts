import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { db } from "@test-evals/db";
import { runs, caseResults } from "@test-evals/db";
import type { ExtractionStrategy, RunSummary, RunResult, CaseResult } from "@test-evals/shared";
import { createRun, startRun, resumeRun } from "../services/runner.service.js";
import { listTranscriptIds, loadGold, loadTranscript } from "../services/dataset.service.js";

export const runsRouter = new Hono();

runsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    strategy: ExtractionStrategy;
    model?: string;
    dataset_filter?: string[];
    force?: boolean;
  }>();

  const strategy = body.strategy;
  const model = body.model ?? process.env.MODEL ?? "claude-haiku-4-5-20251001";
  const datasetFilter = body.dataset_filter ?? null;
  const force = body.force ?? false;

  if (!["zero_shot", "few_shot", "cot"].includes(strategy)) {
    return c.json({ error: "Invalid strategy" }, 400);
  }

  const runId = await createRun(strategy, model, datasetFilter);
  const transcriptIds = datasetFilter ?? listTranscriptIds();
  Promise.resolve().then(() => startRun(runId, strategy, model, transcriptIds, null, { force })).catch(console.error);
  return c.json({ runId });
});

runsRouter.get("/", async (c) => {
  const allRuns = await db.select().from(runs).orderBy(runs.createdAt);

  const summaries: RunSummary[] = allRuns.map((r) => ({
    id: r.id,
    strategy: r.strategy as ExtractionStrategy,
    model: r.model,
    status: r.status as RunSummary["status"],
    aggregateF1: r.aggregateF1 !== null ? Number(r.aggregateF1) : null,
    totalCostUsd: Number(r.totalCostUsd),
    totalTokensCacheRead: r.totalTokensCacheRead,
    totalTokensCacheWrite: r.totalTokensCacheWrite,
    wallTimeMs: r.wallTimeMs,
    totalCases: r.totalCases,
    completedCases: r.completedCases,
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json(summaries);
});

runsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!run) return c.json({ error: "Run not found" }, 404);

  const cases = await db.select().from(caseResults).where(eq(caseResults.runId, id));

  const result: RunResult = {
    id: run.id,
    strategy: run.strategy as ExtractionStrategy,
    model: run.model,
    promptHash: run.promptHash,
    status: run.status as RunResult["status"],
    datasetFilter: run.datasetFilter ? (JSON.parse(run.datasetFilter) as string[]) : null,
    totalCases: run.totalCases,
    completedCases: run.completedCases,
    failedCases: run.failedCases,
    hallucinationCount: run.hallucinationCount,
    schemaFailureCount: run.schemaFailureCount,
    totalTokensInput: run.totalTokensInput,
    totalTokensOutput: run.totalTokensOutput,
    totalTokensCacheRead: run.totalTokensCacheRead,
    totalTokensCacheWrite: run.totalTokensCacheWrite,
    totalCostUsd: Number(run.totalCostUsd),
    wallTimeMs: run.wallTimeMs,
    aggregateF1: run.aggregateF1 !== null ? Number(run.aggregateF1) : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    cases: cases.map(
      (cr): CaseResult => ({
        id: cr.id,
        runId: cr.runId,
        transcriptId: cr.transcriptId,
        strategy: cr.strategy as ExtractionStrategy,
        model: cr.model,
        status: cr.status as CaseResult["status"],
        transcript: loadTranscript(cr.transcriptId),
        gold: loadGold(cr.transcriptId),
        prediction: cr.prediction ? (JSON.parse(cr.prediction) as CaseResult["prediction"]) : null,
        scores: cr.scores ? (JSON.parse(cr.scores) as CaseResult["scores"]) : null,
        hallucinations: cr.hallucinations ? (JSON.parse(cr.hallucinations) as CaseResult["hallucinations"]) : [],
        attempts: cr.attempts ? (JSON.parse(cr.attempts) as CaseResult["attempts"]) : [],
        tokensInput: cr.tokensInput,
        tokensOutput: cr.tokensOutput,
        tokensCacheRead: cr.tokensCacheRead,
        tokensCacheWrite: cr.tokensCacheWrite,
        costUsd: Number(cr.costUsd),
        wallTimeMs: cr.wallTimeMs,
        error: cr.error,
        createdAt: cr.createdAt.toISOString(),
      }),
    ),
  };

  return c.json(result);
});

runsRouter.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!run) return c.json({ error: "Run not found" }, 404);
  Promise.resolve().then(() => resumeRun(id, null)).catch(console.error);
  return c.json({ resumed: true });
});

runsRouter.get("/:id/stream", async (c) => {
  const id = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!run) return c.json({ error: "Run not found" }, 404);

  return streamSSE(c, async (stream) => {
    const sseController = {
      write: (data: string) => {
        stream.writeSSE({ data }).catch(console.error);
      },
    };

    if (run.status === "pending" || run.status === "running") {
      const transcriptIds = run.datasetFilter
        ? (JSON.parse(run.datasetFilter) as string[])
        : listTranscriptIds();
      await startRun(id, run.strategy as ExtractionStrategy, run.model, transcriptIds, sseController);
    } else {
      await stream.writeSSE({
        data: JSON.stringify({ type: "run_complete", runId: id, status: run.status }),
      });
    }
  });
});
