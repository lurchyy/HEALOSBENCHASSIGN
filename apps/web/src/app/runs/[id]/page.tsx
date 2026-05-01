import type { RunResult, FieldScores } from "@test-evals/shared";
import { CaseRow } from "./CaseRow";

async function fetchRun(id: string): Promise<RunResult | null> {
  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${serverUrl}/api/v1/runs/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json() as Promise<RunResult>;
  } catch {
    return null;
  }
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    partial: "bg-orange-100 text-orange-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-800"}`}>
      {status}
    </span>
  );
}

const FIELD_NAMES: Array<keyof FieldScores> = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"];

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await fetchRun(id);

  if (!run) {
    return <div className="p-6 text-red-600">Run not found.</div>;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Run Detail</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Strategy</div>
          <div className="font-semibold">{run.strategy}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Model</div>
          <div className="font-semibold text-sm">{run.model}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Status</div>
          <div className="mt-1">{statusBadge(run.status)}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Aggregate F1</div>
          <div className="font-semibold text-lg">{run.aggregateF1 !== null ? run.aggregateF1.toFixed(4) : "—"}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Total Cost</div>
          <div className="font-semibold">${run.totalCostUsd.toFixed(6)}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Wall Time</div>
          <div className="font-semibold">{run.wallTimeMs !== null ? `${(run.wallTimeMs / 1000).toFixed(1)}s` : "—"}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Cases</div>
          <div className="font-semibold">{run.completedCases}/{run.totalCases}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Hallucinations</div>
          <div className="font-semibold">{run.hallucinationCount}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Cache Read</div>
          <div className="font-semibold">{run.totalTokensCacheRead.toLocaleString()}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">Cache Write</div>
          <div className="font-semibold">{run.totalTokensCacheWrite.toLocaleString()}</div>
        </div>
      </div>

      <h2 className="text-lg font-semibold mb-3">Cases</h2>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 uppercase text-xs">
            <tr>
              <th className="px-4 py-3 text-left">Transcript</th>
              <th className="px-4 py-3 text-left">Status</th>
              {FIELD_NAMES.map((f) => (
                <th key={f} className="px-3 py-3 text-right text-xs">{f.replace("_", " ")}</th>
              ))}
              <th className="px-3 py-3 text-right">Agg F1</th>
              <th className="px-3 py-3 text-right">Hall.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {run.cases.map((c) => (
              <CaseRow key={c.id} caseResult={c} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
