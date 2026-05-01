import { config } from "dotenv";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "../.env") });
import { parseArgs } from "util";
import type { ClinicalExtraction, ExtractionStrategy, FieldScores } from "@test-evals/shared";
import { listTranscriptIds, loadTranscript, loadGold } from "./services/dataset.service.js";
import { extract } from "./services/extract.service.js";
import { evaluateCase, aggregateF1 } from "./services/evaluate.service.js";
import { runWithRateLimitRetries } from "./services/run-utils.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    strategy: { type: "string", default: "zero_shot" },
    model: { type: "string", default: "claude-haiku-4-5-20251001" },
  },
  allowPositionals: false,
});

const strategy = (values.strategy ?? "zero_shot") as ExtractionStrategy;
const model = (values.model ?? "claude-haiku-4-5-20251001") as string;
const COST_CAP_USD = parseFloat(process.env.COST_CAP_USD ?? "1.0");
const EVAL_CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY ?? "3", 10);

const HAIKU_INPUT_COST = 0.00000025;
const HAIKU_OUTPUT_COST = 0.00000125;

function estimateCaseCost(transcript: string): number {
  const inputTokens = Math.ceil(transcript.length / 4) + 1200;
  return inputTokens * HAIKU_INPUT_COST + 900 * HAIKU_OUTPUT_COST;
}

if (!["zero_shot", "few_shot", "cot"].includes(strategy)) {
  console.error(`Invalid strategy: ${strategy}. Must be one of: zero_shot, few_shot, cot`);
  process.exit(1);
}

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise((resolve) => { this.queue.push(() => { this.running++; resolve(); }); });
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

interface CaseReport {
  transcriptId: string;
  scores: FieldScores;
  prediction: ClinicalExtraction | null;
  aggregateF1: number;
  hallucinations: Array<{ field: string; value: string }>;
  isSchemaValid: boolean;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  error?: string;
}

async function main() {
  console.log(`\nHEALOSBENCH Evaluation`);
  console.log(`Strategy: ${strategy} | Model: ${model}`);
  console.log("─".repeat(60));

  const transcriptIds = listTranscriptIds();

  // Pre-run cost estimate — abort before spending anything if projected total exceeds cap.
  const projectedCost = transcriptIds.reduce((sum, id) => sum + estimateCaseCost(loadTranscript(id)), 0);
  console.log(`Projected cost (worst-case, no caching): $${projectedCost.toFixed(4)}`);
  if (projectedCost > COST_CAP_USD) {
    console.error(`\nAborted: projected cost $${projectedCost.toFixed(4)} exceeds cap of $${COST_CAP_USD}.`);
    console.error(`Set COST_CAP_USD env var to override (current: ${COST_CAP_USD}).`);
    process.exit(1);
  }

  console.log(`Running ${transcriptIds.length} cases with max ${EVAL_CONCURRENCY} concurrent...\n`);

  const semaphore = new Semaphore(EVAL_CONCURRENCY);
  const reports: CaseReport[] = [];
  let schemaFailureCount = 0;
  let runningCostUsd = 0; // updated after each case; JS single-threaded so no race

  const tasks = transcriptIds.map(async (id) => {
    await semaphore.acquire();
    try {
      const transcript = loadTranscript(id);
      const gold = loadGold(id);

      // Per-case pre-call check: if accumulated + estimate would exceed cap, skip.
      const estimatedCase = estimateCaseCost(transcript);
      if (runningCostUsd + estimatedCase > COST_CAP_USD) {
        console.error(`  [${id}] SKIPPED: cost cap $${COST_CAP_USD} would be exceeded (accumulated: $${runningCostUsd.toFixed(6)})`);
        reports.push({
          transcriptId: id,
          scores: { chief_complaint: 0, vitals: 0, medications: 0, diagnoses: 0, plan: 0, follow_up: 0 },
          prediction: null,
          aggregateF1: 0,
          hallucinations: [],
          isSchemaValid: false,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          costUsd: 0,
          error: "cost_cap_exceeded",
        });
        return;
      }

      while (true) {
        try {
          const { extraction, usage, isSchemaValid } = await runWithRateLimitRetries(
            () => extract(transcript, strategy, model),
            { maxRetries: 3, delayMs: 10000 },
          );
          if (!isSchemaValid) schemaFailureCount++;
          const { scores, hallucinations } = evaluateCase(extraction, gold, transcript);
          const agg = aggregateF1(scores);
          const cost =
            usage.input_tokens * 0.00000025 +
            usage.output_tokens * 0.00000125 +
            usage.cache_write_input_tokens * 0.0000003 +
            usage.cache_read_input_tokens * 0.000000025;

          runningCostUsd += cost;
          const report: CaseReport = {
            transcriptId: id,
            scores,
            prediction: extraction,
            aggregateF1: agg,
            hallucinations,
            isSchemaValid,
            tokensInput: usage.input_tokens,
            tokensOutput: usage.output_tokens,
            tokensCacheRead: usage.cache_read_input_tokens,
            tokensCacheWrite: usage.cache_write_input_tokens,
            costUsd: cost,
          };
          reports.push(report);
          process.stdout.write(
            `  [${id}] F1=${agg.toFixed(3)} cache=${usage.cache_read_input_tokens}/${usage.cache_write_input_tokens} cost=$${cost.toFixed(5)} total=$${runningCostUsd.toFixed(5)}\n`,
          );
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [${id}] FAILED: ${msg}`);
          reports.push({
            transcriptId: id,
            scores: { chief_complaint: 0, vitals: 0, medications: 0, diagnoses: 0, plan: 0, follow_up: 0 },
            prediction: null,
            aggregateF1: 0,
            hallucinations: [],
            isSchemaValid: false,
            tokensInput: 0,
            tokensOutput: 0,
            tokensCacheRead: 0,
            tokensCacheWrite: 0,
            costUsd: 0,
            error: msg,
          });
          break;
        }
      }
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(tasks);

  // Aggregate stats
  const completed = reports.filter((r) => !r.error);
  const failed = reports.filter((r) => r.error);
  const totalF1 = completed.reduce((s, r) => s + r.aggregateF1, 0);
  const meanF1 = completed.length > 0 ? totalF1 / completed.length : 0;
  const totalTokensIn = reports.reduce((s, r) => s + r.tokensInput, 0);
  const totalTokensOut = reports.reduce((s, r) => s + r.tokensOutput, 0);
  const totalTokensCacheRead = reports.reduce((s, r) => s + r.tokensCacheRead, 0);
  const totalTokensCacheWrite = reports.reduce((s, r) => s + r.tokensCacheWrite, 0);
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);
  const totalHallucinations = reports.reduce((s, r) => s + r.hallucinations.length, 0);

  // Per-field averages
  const fieldNames: Array<keyof FieldScores> = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"];
  const fieldAvgs: Partial<FieldScores> = {};
  for (const field of fieldNames) {
    const avg = completed.length > 0
      ? completed.reduce((s, r) => s + r.scores[field], 0) / completed.length
      : 0;
    fieldAvgs[field] = avg;
  }

  console.log("\n" + "─".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("─".repeat(60));
  console.log(`Cases:             ${completed.length}/${reports.length} completed, ${failed.length} failed`);
  console.log(`\nPer-field F1:`);
  for (const field of fieldNames) {
    const val = (fieldAvgs[field] ?? 0).toFixed(4);
    console.log(`  ${field.padEnd(20)} ${val}`);
  }
  console.log(`\nAggregate F1:      ${meanF1.toFixed(4)}`);
  console.log(`Total tokens in:   ${totalTokensIn}`);
  console.log(`Total tokens out:  ${totalTokensOut}`);
  console.log(`Cache tokens read: ${totalTokensCacheRead}`);
  console.log(`Cache tokens write: ${totalTokensCacheWrite}`);
  console.log(`Total cost USD:    $${totalCost.toFixed(6)}`);
  console.log(`Hallucinations:    ${totalHallucinations}`);
  console.log(`Schema failures:   ${schemaFailureCount}`);
  console.log("─".repeat(60));

  // Write results file
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(process.cwd(), "results");
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = resolve(resultsDir, `${strategy}_${model}_${timestamp}.json`);
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        strategy,
        model,
        timestamp,
        summary: {
          completedCases: completed.length,
          failedCases: failed.length,
          aggregateF1: meanF1,
          fieldAverages: fieldAvgs,
          totalTokensInput: totalTokensIn,
          totalTokensOutput: totalTokensOut,
          totalTokensCacheRead,
          totalTokensCacheWrite,
          totalCostUsd: totalCost,
          hallucinationCount: totalHallucinations,
          schemaFailureCount,
        },
        cases: reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
