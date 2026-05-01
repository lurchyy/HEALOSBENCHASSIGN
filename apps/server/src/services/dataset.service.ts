import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { ClinicalExtraction } from "@test-evals/shared";

function getDataDir(): string {
  return process.env.DATA_DIR ?? resolve(process.cwd(), "data");
}

export function listTranscriptIds(): string[] {
  const dataDir = getDataDir();
  const transcriptsDir = resolve(dataDir, "transcripts");
  const files = readdirSync(transcriptsDir);
  return files
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(".txt", ""))
    .sort();
}

export function loadTranscript(id: string): string {
  const dataDir = getDataDir();
  const filePath = resolve(dataDir, "transcripts", `${id}.txt`);
  return readFileSync(filePath, "utf-8");
}

export function loadGold(id: string): ClinicalExtraction {
  const dataDir = getDataDir();
  const filePath = resolve(dataDir, "gold", `${id}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as ClinicalExtraction;
}
