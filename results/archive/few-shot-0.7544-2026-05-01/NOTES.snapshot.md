# HEALOSBENCH Notes

## Results

| Strategy   | Model                      | Agg F1 | Cost ($) | Hallucinations | Schema Failures |
|------------|----------------------------|--------|----------|----------------|-----------------|
| zero_shot  | claude-haiku-4-5-20251001  | 0.7008 | 0.0475   | 12             | 0               |
| few_shot   | claude-haiku-4-5-20251001  | 0.7544 | 0.0675   | 16             | 0               |
| cot        | claude-haiku-4-5-20251001  | 0.7066 | 0.0498   | 17             | 0               |

Run with: `bun run eval -- --strategy=zero_shot --model=claude-haiku-4-5-20251001`

The completed run files are in `results/`. The current submission runs are `zero_shot_claude-haiku-4-5-20251001_2026-05-01T09-27-41-856Z.json`, `few_shot_claude-haiku-4-5-20251001_2026-05-01T09-25-55-607Z.json`, and `cot_claude-haiku-4-5-20251001_2026-05-01T09-29-34-182Z.json`. A few earlier zero-shot result files failed all 50 cases because the Anthropic API key was not loaded; those setup-failure files were moved to `results/failed-auth/` and should be ignored for prompt comparison. One partial few-shot run failed 1 case due to an Anthropic 429 and was moved to `results/failed-rate-limit/`.

## Prompt Caching Verification

- The Anthropic wrapper reads `cache_read_input_tokens` and `cache_creation_input_tokens` from every response.
- Server runs persist cache totals on both `case_results` and `runs`, then surface them in the runs list, run detail page, and compare page.
- CLI eval output now prints per-case cache read/write tokens and writes `totalTokensCacheRead` plus `totalTokensCacheWrite` into future result JSON summaries.
- The latest full CLI runs reported `0` cache read/write tokens, so the code now exposes cache evidence but Anthropic did not return cache hits for these prompts.

## What Surprised Me

- Few-shot won overall after grounding improvements, reaching 0.7544 aggregate F1 with only 16 hallucination flags.
- Average hallucination flags across zero-shot, few-shot, and CoT fell from roughly 350+ per run to 15 per run.
- Vitals scored 1.0 across all strategies, suggesting the schema and transcript format make those fields comparatively easy.
- Chain-of-thought underperformed zero-shot here. The extra reasoning prompt did not translate into better extraction quality for this dataset.
- The original hallucination detector was over-strict for clinically grounded summaries; gold-vs-gold now reports 0 hallucinations across all 50 cases.

## Per-Field Averages

| Strategy | Chief Complaint | Vitals | Medications | Diagnoses | Plan | Follow Up |
|----------|-----------------|--------|-------------|-----------|------|-----------|
| zero_shot | 0.4025 | 1.0000 | 0.9287 | 0.6533 | 0.5257 | 0.6948 |
| few_shot | 0.5577 | 1.0000 | 0.8625 | 0.7667 | 0.6302 | 0.7094 |
| cot | 0.4233 | 1.0000 | 0.9180 | 0.6693 | 0.5478 | 0.6812 |

## Hallucination Detection

For each predicted string value (chief_complaint, medication names, diagnosis descriptions, plan items, follow_up reason):

1. Normalize both the predicted value and the full transcript: lowercase, strip punctuation, collapse whitespace.
2. If the predicted value fuzzy-matches the human gold value for that field, treat it as supported.
3. Otherwise, check exact substring support, then token-level support over the full transcript and local transcript windows.
4. If neither gold match nor transcript support passes, flag as hallucination: `{ field, value }`.

This catches values the model invented that have no grounding in the source text.

## Concurrency Strategy

- A semaphore limits concurrent LLM calls. The default is 3 concurrent cases via `EVAL_CONCURRENCY=3`.
- All transcript tasks are mapped to async functions that `acquire()` the semaphore before calling the LLM and `release()` in a `finally` block.
- On HTTP 429 (rate limit) from Anthropic, shared retry logic waits 10 seconds and retries up to 3 times before marking the case failed.
- This applies in both the CLI eval script and the HTTP server runner service.

## Validation

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd apps/server test` passed with 23 tests and 2 opt-in DB integration tests skipped.
- `PATH="$HOME/.bun/bin:$PATH" bunx turbo check-types` passed.
- `cmd.exe /c "cd /d C:\Users\Abhyudya\Documents\projexts\New folder\healosbench\apps\web && bunx next build"` passed with Windows Node 22.14.0.
- DB integration tests for idempotency and resumability are opt-in with `RUN_DB_TESTS=1` so normal test runs do not require a live Postgres database.
- A secret scan found only placeholder env examples in `README.md` and `apps/server/.env.example`; no real Anthropic key was found outside ignored `.env` files.

## What Would Be Built Next

- **Prompt diff view**: highlight exactly which tokens changed between two prompt hashes, useful when iterating on system prompts.
- **Streaming progress in web UI**: the `/runs/:id/stream` SSE endpoint exists; the web UI could connect to it for live case-by-case updates instead of polling.
- **Per-field confidence intervals**: bootstrap resampling across the 50 cases to report 95% CI on each field score.

## What Was Cut

- **Multi-user auth**: auth is intentionally out of scope per the README, so the active eval dashboard and API do not require login.
- **Multi-tenancy**: all runs share a single DB schema. A tenant-aware design would need organization-scoped IDs and row-level security.
- **Prompt versioning UI**: prompt hashes are stored in the DB but there's no UI to browse prompt history or diff two hashes side-by-side.
- **Full browser smoke recording**: eval dashboard pages were built for manual inspection, but a Playwright screenshot suite was not added.
