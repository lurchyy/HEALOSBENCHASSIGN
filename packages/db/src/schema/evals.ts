import { pgTable, text, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  strategy: text("strategy").notNull(),
  model: text("model").notNull(),
  promptHash: text("prompt_hash").notNull(),
  status: text("status").notNull().default("pending"),
  datasetFilter: text("dataset_filter"),
  totalCases: integer("total_cases").notNull().default(0),
  completedCases: integer("completed_cases").notNull().default(0),
  failedCases: integer("failed_cases").notNull().default(0),
  hallucinationCount: integer("hallucination_count").notNull().default(0),
  schemaFailureCount: integer("schema_failure_count").notNull().default(0),
  totalTokensInput: integer("total_tokens_input").notNull().default(0),
  totalTokensOutput: integer("total_tokens_output").notNull().default(0),
  totalTokensCacheRead: integer("total_tokens_cache_read").notNull().default(0),
  totalTokensCacheWrite: integer("total_tokens_cache_write").notNull().default(0),
  totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  wallTimeMs: integer("wall_time_ms"),
  aggregateF1: numeric("aggregate_f1", { precision: 5, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const caseResults = pgTable(
  "case_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    transcriptId: text("transcript_id").notNull(),
    strategy: text("strategy").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("pending"),
    prediction: text("prediction"),
    scores: text("scores"),
    hallucinations: text("hallucinations"),
    attempts: text("attempts"),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    tokensCacheRead: integer("tokens_cache_read").notNull().default(0),
    tokensCacheWrite: integer("tokens_cache_write").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    wallTimeMs: integer("wall_time_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("case_results_run_transcript_unique").on(table.runId, table.transcriptId)],
);
