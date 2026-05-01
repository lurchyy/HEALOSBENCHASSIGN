import Link from "next/link";
import type { RunSummary } from "@test-evals/shared";

async function fetchRuns(): Promise<RunSummary[]> {
  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${serverUrl}/api/v1/runs`, { cache: "no-store" });
    if (!res.ok) return [];
    return res.json() as Promise<RunSummary[]>;
  } catch {
    return [];
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

export default async function RunsPage() {
  const runs = await fetchRuns();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Evaluation Runs</h1>
        <Link href="/compare" className="text-sm text-blue-600 hover:underline">
          Compare runs →
        </Link>
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No runs yet. Start one with the CLI: <code className="bg-gray-100 px-1 rounded">bun run eval</code>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 uppercase text-xs">
              <tr>
                <th className="px-4 py-3 text-left">ID</th>
                <th className="px-4 py-3 text-left">Strategy</th>
                <th className="px-4 py-3 text-left">Model</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Agg F1</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3 text-right">Cache R/W</th>
                <th className="px-4 py-3 text-right">Duration</th>
                <th className="px-4 py-3 text-right">Cases</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/runs/${run.id}`} className="text-blue-600 hover:underline font-mono text-xs">
                      {run.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">{run.strategy}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{run.model}</td>
                  <td className="px-4 py-3">{statusBadge(run.status)}</td>
                  <td className="px-4 py-3 text-right">
                    {run.aggregateF1 !== null ? run.aggregateF1.toFixed(4) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    ${run.totalCostUsd.toFixed(4)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-gray-600">
                    {run.totalTokensCacheRead.toLocaleString()} / {run.totalTokensCacheWrite.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {run.wallTimeMs !== null ? `${(run.wallTimeMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {run.completedCases}/{run.totalCases}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(run.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
