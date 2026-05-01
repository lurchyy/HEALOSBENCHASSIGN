export type CachedCaseResult = {
  transcriptId: string;
  strategy: string;
  model: string;
  prediction: string | null;
  scores: string | null;
  hallucinations: string | null;
  attempts: string | null;
};

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

export async function runWithRateLimitRetries<T>(
  operation: () => Promise<T>,
  options?: { maxRetries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const delayMs = options?.delayMs ?? 10000;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let retries = 0;

  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (!isRateLimitError(err) || retries >= maxRetries) {
        throw err;
      }
      retries++;
      await sleep(delayMs);
    }
  }
}

export function buildCachedCaseResultValues(cached: CachedCaseResult, caseId: string, runId: string) {
  return {
    id: caseId,
    runId,
    transcriptId: cached.transcriptId,
    strategy: cached.strategy,
    model: cached.model,
    status: "completed",
    prediction: cached.prediction,
    scores: cached.scores,
    hallucinations: cached.hallucinations,
    attempts: cached.attempts,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUsd: "0",
    wallTimeMs: 0,
    error: null,
  };
}

export function getRemainingTranscriptIds(allIds: string[], completedIds: Set<string>): string[] {
  return allIds.filter((id) => !completedIds.has(id));
}
