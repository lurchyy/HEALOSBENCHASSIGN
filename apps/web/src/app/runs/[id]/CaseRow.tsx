"use client";
import { useState } from "react";
import type { CaseResult, ClinicalExtraction, FieldScores } from "@test-evals/shared";

const FIELD_NAMES: Array<keyof FieldScores> = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"];

function scoreColor(score: number): string {
  if (score >= 0.8) return "text-green-600";
  if (score >= 0.5) return "text-yellow-600";
  return "text-red-600";
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-800"}`}>
      {status}
    </span>
  );
}

function aggF1(scores: FieldScores): number {
  const vals = Object.values(scores);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function isCachedResult(caseResult: CaseResult): boolean {
  return (
    caseResult.status === "completed" &&
    caseResult.costUsd === 0 &&
    caseResult.tokensInput === 0 &&
    caseResult.tokensOutput === 0
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractionStrings(extraction: ClinicalExtraction | null): string[] {
  if (!extraction) return [];
  return [
    extraction.chief_complaint,
    extraction.vitals.bp,
    extraction.vitals.hr?.toString(),
    extraction.vitals.temp_f?.toString(),
    extraction.vitals.spo2?.toString(),
    ...extraction.medications.flatMap((m) => [m.name, m.dose, m.frequency, m.route]),
    ...extraction.diagnoses.map((d) => d.description),
    ...extraction.plan,
    extraction.follow_up.interval_days?.toString(),
    extraction.follow_up.reason,
  ]
    .filter((value): value is string => Boolean(value && value.trim().length >= 3))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length)
    .slice(0, 30);
}

function highlightedTranscript(transcript: string | undefined, prediction: ClinicalExtraction | null) {
  if (!transcript) return <span className="text-gray-400">Transcript unavailable.</span>;
  const values = extractionStrings(prediction);
  if (values.length === 0) return transcript;
  const pattern = new RegExp(`(${values.map(escapeRegExp).join("|")})`, "gi");
  return transcript.split(pattern).map((part, index) => {
    const isMatch = values.some((value) => value.toLowerCase() === part.toLowerCase());
    return isMatch ? (
      <mark key={index} className="rounded bg-amber-100 px-0.5 text-amber-950">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    );
  });
}

function fieldPreview(extraction: ClinicalExtraction | null, field: keyof FieldScores): string {
  if (!extraction) return "null";
  switch (field) {
    case "chief_complaint":
      return extraction.chief_complaint;
    case "vitals":
      return JSON.stringify(extraction.vitals);
    case "medications":
      return extraction.medications.map((m) => `${m.name} ${m.dose ?? ""} ${m.frequency ?? ""}`.trim()).join("; ") || "[]";
    case "diagnoses":
      return extraction.diagnoses.map((d) => d.description).join("; ") || "[]";
    case "plan":
      return extraction.plan.join("; ") || "[]";
    case "follow_up":
      return JSON.stringify(extraction.follow_up);
  }
}

export function CaseRow({ caseResult }: { caseResult: CaseResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="px-4 py-2 font-mono text-xs">{caseResult.transcriptId}</td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            {statusBadge(caseResult.status)}
            {isCachedResult(caseResult) && (
              <span className="rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                cached
              </span>
            )}
          </div>
        </td>
        {FIELD_NAMES.map((f) => (
          <td key={f} className={`px-3 py-2 text-right text-xs ${caseResult.scores ? scoreColor(caseResult.scores[f]) : ""}`}>
            {caseResult.scores ? caseResult.scores[f].toFixed(3) : "—"}
          </td>
        ))}
        <td className={`px-3 py-2 text-right font-semibold text-xs ${caseResult.scores ? scoreColor(aggF1(caseResult.scores)) : ""}`}>
          {caseResult.scores ? aggF1(caseResult.scores).toFixed(3) : "—"}
        </td>
        <td className="px-3 py-2 text-right text-xs">{caseResult.hallucinations.length}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} className="bg-gray-50 px-4 py-4">
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.25fr] gap-4">
              <div>
                <h3 className="font-semibold mb-2 text-sm">Transcript</h3>
                <pre className="text-xs leading-5 whitespace-pre-wrap bg-white border rounded p-3 overflow-auto max-h-80">
                  {highlightedTranscript(caseResult.transcript, caseResult.prediction)}
                </pre>
              </div>
              <div>
                <h3 className="font-semibold mb-2 text-sm">Field Diff</h3>
                <div className="overflow-x-auto border rounded bg-white">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-100 text-gray-600">
                      <tr>
                        <th className="px-2 py-2 text-left">Field</th>
                        <th className="px-2 py-2 text-right">Score</th>
                        <th className="px-2 py-2 text-left">Gold</th>
                        <th className="px-2 py-2 text-left">Prediction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {FIELD_NAMES.map((field) => (
                        <tr key={field}>
                          <td className="px-2 py-2 font-medium">{field.replace("_", " ")}</td>
                          <td className={`px-2 py-2 text-right ${caseResult.scores ? scoreColor(caseResult.scores[field]) : ""}`}>
                            {caseResult.scores ? caseResult.scores[field].toFixed(3) : "—"}
                          </td>
                          <td className="px-2 py-2 max-w-64 align-top">{fieldPreview(caseResult.gold ?? null, field)}</td>
                          <td className="px-2 py-2 max-w-64 align-top">{fieldPreview(caseResult.prediction, field)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
              <div>
                <h3 className="font-semibold mb-2 text-sm">Gold JSON</h3>
                <pre className="text-xs bg-white border rounded p-3 overflow-auto max-h-72">
                  {caseResult.gold ? JSON.stringify(caseResult.gold, null, 2) : "null"}
                </pre>
              </div>
              <div>
                <h3 className="font-semibold mb-2 text-sm">Prediction JSON</h3>
                <pre className="text-xs bg-white border rounded p-3 overflow-auto max-h-72">
                  {caseResult.prediction ? JSON.stringify(caseResult.prediction, null, 2) : "null"}
                </pre>
              </div>
            </div>
            <div className="mt-4">
              <h3 className="font-semibold mb-2 text-sm">LLM Attempts ({caseResult.attempts.length})</h3>
              <div className="space-y-2">
                {caseResult.attempts.map((a) => (
                  <details key={a.attempt} className={`text-xs rounded border ${a.success ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
                    <summary className="cursor-pointer p-2">
                      <span className="font-medium">Attempt {a.attempt}</span> - {a.success ? "success" : "failed"}
                    </summary>
                    <div className="px-2 pb-2">
                      {a.validationErrors && (
                        <ul className="mb-2 list-disc list-inside text-red-700">
                          {a.validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      )}
                      <pre className="max-h-48 overflow-auto rounded bg-white p-2">{a.rawResponse}</pre>
                    </div>
                  </details>
                ))}
              </div>
            </div>
            {caseResult.hallucinations.length > 0 && (
              <div className="mt-3">
                <h3 className="font-semibold mb-1 text-sm text-red-700">Hallucinations</h3>
                <div className="flex flex-wrap gap-2">
                  {caseResult.hallucinations.map((h, i) => (
                    <span key={i} className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                      {h.field}: "{h.value}"
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 text-xs text-gray-500">
              Tokens: {caseResult.tokensInput} in / {caseResult.tokensOutput} out / {caseResult.tokensCacheRead} cache read
              {" | "}Cost: ${caseResult.costUsd.toFixed(6)}
              {caseResult.wallTimeMs && ` | ${caseResult.wallTimeMs}ms`}
              {isCachedResult(caseResult) && " | reused cached result"}
            </div>
            {caseResult.error && (
              <div className="mt-2 text-xs text-red-700 bg-red-50 p-2 rounded border border-red-200">
                Error: {caseResult.error}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
