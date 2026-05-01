"use client";
import { useState, useEffect } from "react";
import type { RunSummary, RunResult, FieldScores } from "@test-evals/shared";

const FIELD_NAMES: Array<keyof FieldScores> = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"];
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

async function fetchRuns(): Promise<RunSummary[]> {
  const res = await fetch(`${SERVER_URL}/api/v1/runs`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json() as Promise<RunSummary[]>;
}

async function fetchRun(id: string): Promise<RunResult | null> {
  const res = await fetch(`${SERVER_URL}/api/v1/runs/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json() as Promise<RunResult>;
}

function computeFieldAvgs(run: RunResult): Partial<FieldScores> {
  const completed = run.cases.filter((c) => c.scores !== null);
  if (completed.length === 0) return {};
  const result: Partial<FieldScores> = {};
  for (const field of FIELD_NAMES) {
    result[field] = completed.reduce((s, c) => s + (c.scores ? c.scores[field] : 0), 0) / completed.length;
  }
  return result;
}

function deltaColor(delta: number): string {
  if (delta > 0.01) return "text-green-600";
  if (delta < -0.01) return "text-red-600";
  return "text-gray-600";
}

function caseAgg(scores: FieldScores): number {
  const values = Object.values(scores);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function winnerSummary(avgsA: Partial<FieldScores>, avgsB: Partial<FieldScores>) {
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const field of FIELD_NAMES) {
    const delta = (avgsB[field] ?? 0) - (avgsA[field] ?? 0);
    if (Math.abs(delta) < 0.005) ties++;
    else if (delta > 0) winsB++;
    else winsA++;
  }
  return { winsA, winsB, ties };
}

function worstRegressions(runA: RunResult, runB: RunResult) {
  const byTranscript = new Map(runA.cases.filter((c) => c.scores).map((c) => [c.transcriptId, c]));
  return runB.cases
    .filter((caseB) => caseB.scores && byTranscript.get(caseB.transcriptId)?.scores)
    .map((caseB) => {
      const caseA = byTranscript.get(caseB.transcriptId);
      const scoreA = caseA?.scores ? caseAgg(caseA.scores) : 0;
      const scoreB = caseB.scores ? caseAgg(caseB.scores) : 0;
      return { transcriptId: caseB.transcriptId, scoreA, scoreB, delta: scoreB - scoreA };
    })
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 5);
}

export default function ComparePage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [dataA, setDataA] = useState<RunResult | null>(null);
  const [dataB, setDataB] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchRuns().then(setRuns).catch(console.error);
  }, []);

  async function handleCompare() {
    if (!runA || !runB) { setError("Select both runs"); return; }
    setLoading(true);
    setError("");
    try {
      const [a, b] = await Promise.all([fetchRun(runA), fetchRun(runB)]);
      if (!a || !b) { setError("Failed to load one or both runs"); return; }
      setDataA(a);
      setDataB(b);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const avgsA = dataA ? computeFieldAvgs(dataA) : null;
  const avgsB = dataB ? computeFieldAvgs(dataB) : null;
  const winners = avgsA && avgsB ? winnerSummary(avgsA, avgsB) : null;
  const regressions = dataA && dataB ? worstRegressions(dataA, dataB) : [];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Compare Runs</h1>

      <div className="flex gap-4 items-end mb-6">
        <div>
          <label className="block text-sm font-medium mb-1">Run A</label>
          <select
            className="border rounded px-3 py-2 text-sm"
            value={runA}
            onChange={(e) => setRunA(e.target.value)}
          >
            <option value="">— Select —</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 8)} — {r.strategy} / {r.model.slice(0, 20)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Run B</label>
          <select
            className="border rounded px-3 py-2 text-sm"
            value={runB}
            onChange={(e) => setRunB(e.target.value)}
          >
            <option value="">— Select —</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 8)} — {r.strategy} / {r.model.slice(0, 20)}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleCompare}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Compare"}
        </button>
      </div>

      {error && <div className="mb-4 text-red-600 text-sm">{error}</div>}

      {dataA && dataB && avgsA && avgsB && (
        <div>
          <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
            <div className="border rounded-lg p-3 bg-blue-50">
              <div className="font-semibold">Run A: {dataA.strategy}</div>
              <div className="text-gray-600">{dataA.model}</div>
              <div>Agg F1: <strong>{dataA.aggregateF1?.toFixed(4) ?? "—"}</strong></div>
              <div>Cost: ${dataA.totalCostUsd.toFixed(4)}</div>
              <div>Cache R/W: {dataA.totalTokensCacheRead.toLocaleString()} / {dataA.totalTokensCacheWrite.toLocaleString()}</div>
            </div>
            <div className="border rounded-lg p-3 bg-green-50">
              <div className="font-semibold">Run B: {dataB.strategy}</div>
              <div className="text-gray-600">{dataB.model}</div>
              <div>Agg F1: <strong>{dataB.aggregateF1?.toFixed(4) ?? "—"}</strong></div>
              <div>Cost: ${dataB.totalCostUsd.toFixed(4)}</div>
              <div>Cache R/W: {dataB.totalTokensCacheRead.toLocaleString()} / {dataB.totalTokensCacheWrite.toLocaleString()}</div>
            </div>
          </div>

          {winners && (
            <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
              <div className="border rounded-lg p-3 bg-white">
                <div className="font-semibold mb-1">Field Winners</div>
                <div className="text-gray-700">
                  Run A wins {winners.winsA}, Run B wins {winners.winsB}, ties {winners.ties}.
                </div>
              </div>
              <div className="border rounded-lg p-3 bg-white">
                <div className="font-semibold mb-1">Worst B Regressions</div>
                {regressions.length === 0 ? (
                  <div className="text-gray-500">No overlapping scored cases.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {regressions.map((item) => (
                      <span key={item.transcriptId} className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">
                        {item.transcriptId}: {item.delta.toFixed(3)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 uppercase text-xs">
                <tr>
                  <th className="px-4 py-3 text-left">Field</th>
                  <th className="px-4 py-3 text-right">Run A</th>
                  <th className="px-4 py-3 text-right">Run B</th>
                  <th className="px-4 py-3 text-right">Delta (B-A)</th>
                  <th className="px-4 py-3 text-center">Winner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {FIELD_NAMES.map((field) => {
                  const a = avgsA[field] ?? 0;
                  const b = avgsB[field] ?? 0;
                  const delta = b - a;
                  const winner = Math.abs(delta) < 0.005 ? "tie" : delta > 0 ? "B" : "A";
                  return (
                    <tr key={field}>
                      <td className="px-4 py-2 font-medium">{field.replace(/_/g, " ")}</td>
                      <td className="px-4 py-2 text-right">{a.toFixed(4)}</td>
                      <td className="px-4 py-2 text-right">{b.toFixed(4)}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${deltaColor(delta)}`}>
                        {delta > 0 ? "+" : ""}{delta.toFixed(4)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {winner === "tie" ? (
                          <span className="text-gray-500 text-xs">tie</span>
                        ) : (
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${winner === "A" ? "bg-blue-100 text-blue-800" : "bg-green-100 text-green-800"}`}>
                            {winner}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-4 py-2">Aggregate F1</td>
                  <td className="px-4 py-2 text-right">{dataA.aggregateF1?.toFixed(4) ?? "—"}</td>
                  <td className="px-4 py-2 text-right">{dataB.aggregateF1?.toFixed(4) ?? "—"}</td>
                  <td className={`px-4 py-2 text-right ${dataA.aggregateF1 !== null && dataB.aggregateF1 !== null ? deltaColor((dataB.aggregateF1 ?? 0) - (dataA.aggregateF1 ?? 0)) : ""}`}>
                    {dataA.aggregateF1 !== null && dataB.aggregateF1 !== null
                      ? `${((dataB.aggregateF1 ?? 0) - (dataA.aggregateF1 ?? 0)) > 0 ? "+" : ""}${((dataB.aggregateF1 ?? 0) - (dataA.aggregateF1 ?? 0)).toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-center text-xs text-gray-500">overall</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
