import type { ClinicalExtraction, FieldScores, HallucinationFlag } from "@test-evals/shared";

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 0),
  );
}

function tokenSetRatio(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null && b == null) return 1;
  if (a == null || b == null) return 0;
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 && tokB.size === 0) return 1;
  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection++;
  }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function normalizeDose(dose: string | null | undefined): string | null {
  if (dose == null) return null;
  return dose
    .toLowerCase()
    .replace(/\bmilligrams?\b/g, "mg")
    .replace(/\bmicrograms?\b/g, "mcg")
    .replace(/\bgrams?\b/g, "g")
    .replace(/\bmilliliters?\b/g, "ml")
    .replace(/\s+(mg|ml|mcg|g)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFrequency(freq: string | null | undefined): string | null {
  if (freq == null) return null;
  return freq
    .toLowerCase()
    .replace(/\bbid\b/g, "twice daily")
    .replace(/\btid\b/g, "three times daily")
    .replace(/\bqid\b/g, "four times daily")
    .replace(/\bqd\b/g, "once daily")
    .replace(/\bprn\b/g, "as needed")
    .replace(/\bpo\b/g, "")
    .replace(/\bwith food\b/g, "")
    .replace(/\bto start\b/g, "")
    .replace(/\bfor (?:the )?(?:next )?\d+(?:\s+to\s+\d+)?\s+(?:days?|weeks?|months?)\b/g, "")
    .replace(/\bfor first \d+(?:\s+to\s+\d+)?\s+days?\b/g, "")
    .replace(/\bcontinuing (?:for )?(?:the )?first \d+(?:\s+to\s+\d+)?\s+days?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStrengthTokens(text: string | null): string[] {
  if (!text) return [];
  return [...text.matchAll(/\b\d+(?:\.\d+)?(?:mg|mcg|g|ml)\b/g)].map((match) => match[0]);
}

function doseCompatible(predictedDose: string | null | undefined, goldDose: string | null | undefined): boolean {
  const predicted = normalizeDose(predictedDose);
  const gold = normalizeDose(goldDose);
  if (predicted === null && gold === null) return true;
  if (predicted === null || gold === null) return false;
  if (predicted === gold) return true;

  const predictedStrengths = new Set(extractStrengthTokens(predicted));
  const goldStrengths = extractStrengthTokens(gold);
  if (goldStrengths.length > 0) {
    return goldStrengths.every((strength) => predictedStrengths.has(strength));
  }

  return tokenSetRatio(predicted, gold) >= 0.8;
}

function frequencyCompatible(predictedFrequency: string | null | undefined, goldFrequency: string | null | undefined): boolean {
  const predicted = normalizeFrequency(predictedFrequency);
  const gold = normalizeFrequency(goldFrequency);
  if (predicted === null && gold === null) return true;
  if (predicted === null || gold === null) return false;
  if (predicted === gold) return true;

  const predictedTokens = new Set(contentSupportTokens(predicted));
  const goldNumbers = numericTokens(contentSupportTokens(gold));
  if (!goldNumbers.every((token) => predictedTokens.has(token))) return false;

  return tokenSetRatio(predicted, gold) >= 0.6;
}

function scheduleCompatible(
  predicted: { dose: string | null; frequency: string | null },
  gold: { dose: string | null; frequency: string | null },
): boolean {
  if (doseCompatible(predicted.dose, gold.dose) && frequencyCompatible(predicted.frequency, gold.frequency)) {
    return true;
  }

  const predictedSchedule = normalizeFrequency(`${normalizeDose(predicted.dose) ?? ""} ${predicted.frequency ?? ""}`);
  const goldSchedule = normalizeFrequency(`${normalizeDose(gold.dose) ?? ""} ${gold.frequency ?? ""}`);
  if (!predictedSchedule || !goldSchedule) return false;

  const predictedTokens = new Set(contentSupportTokens(predictedSchedule));
  const goldTokens = contentSupportTokens(goldSchedule);
  const goldNumbers = numericTokens(goldTokens);
  const numericOk = goldNumbers.every((token) => predictedTokens.has(token));
  return numericOk && tokenCoverage(goldTokens, predictedTokens) >= 0.75;
}

function medNamesMatch(a: string, b: string): boolean {
  return tokenSetRatio(a, b) >= 0.8;
}

function medsMatch(
  a: { name: string; dose: string | null; frequency: string | null },
  b: { name: string; dose: string | null; frequency: string | null },
): boolean {
  if (!medNamesMatch(a.name, b.name)) return false;
  return scheduleCompatible(a, b);
}

function setF1<T>(predicted: T[], gold: T[], matches: (a: T, b: T) => boolean): number {
  if (gold.length === 0 && predicted.length === 0) return 1;
  if (gold.length === 0 || predicted.length === 0) return 0;

  let tp = 0;
  const usedGold = new Set<number>();
  for (const pred of predicted) {
    for (let i = 0; i < gold.length; i++) {
      const goldItem = gold[i];
      if (goldItem !== undefined && !usedGold.has(i) && matches(pred, goldItem)) {
        tp++;
        usedGold.add(i);
        break;
      }
    }
  }

  const precision = tp / predicted.length;
  const recall = tp / gold.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function scoreVitals(pred: ClinicalExtraction["vitals"], gold: ClinicalExtraction["vitals"]): number {
  const scores: number[] = [];

  if (gold.bp !== null) {
    scores.push(pred.bp === gold.bp ? 1 : 0);
  } else if (pred.bp === null) {
    scores.push(1);
  }

  if (gold.hr !== null) {
    scores.push(pred.hr === gold.hr ? 1 : 0);
  } else if (pred.hr === null) {
    scores.push(1);
  }

  if (gold.temp_f !== null) {
    scores.push(pred.temp_f !== null && Math.abs(pred.temp_f - gold.temp_f) <= 0.2 ? 1 : 0);
  } else if (pred.temp_f === null) {
    scores.push(1);
  }

  if (gold.spo2 !== null) {
    scores.push(pred.spo2 === gold.spo2 ? 1 : 0);
  } else if (pred.spo2 === null) {
    scores.push(1);
  }

  if (scores.length === 0) return 1;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function scoreDiagnoses(pred: ClinicalExtraction["diagnoses"], gold: ClinicalExtraction["diagnoses"]): number {
  return setF1(pred, gold, (a, b) => {
    const descScore = tokenSetRatio(a.description, b.description) >= 0.7;
    const icd10Bonus = a.icd10 && b.icd10 && a.icd10 === b.icd10 ? 0.1 : 0;
    return descScore ? true : icd10Bonus > 0;
  });
}

function scoreFollowUp(pred: ClinicalExtraction["follow_up"], gold: ClinicalExtraction["follow_up"]): number {
  const intervalScore =
    gold.interval_days === null && pred.interval_days === null
      ? 1
      : gold.interval_days === pred.interval_days
        ? 1
        : 0;
  const reasonScore = tokenSetRatio(pred.reason, gold.reason);
  return (intervalScore + reasonScore) / 2;
}

function diagnosisMatchesGold(
  prediction: ClinicalExtraction["diagnoses"][number],
  gold: ClinicalExtraction["diagnoses"][number],
): boolean {
  return tokenSetRatio(prediction.description, gold.description) >= 0.7 ||
    Boolean(prediction.icd10 && gold.icd10 && prediction.icd10 === gold.icd10);
}

function normalizeForHallucinationCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/yellow[\s-]+green/g, "yellow green purulent")
    .replace(/[^\w\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInTranscript(value: string, transcript: string): boolean {
  const normValue = normalizeForHallucinationCheck(value);
  const normTranscript = normalizeForHallucinationCheck(transcript);
  if (normValue.length === 0) return true;
  if (normTranscript.includes(normValue)) return true;

  const valueTokens = contentSupportTokens(normValue);
  if (valueTokens.length === 0) return true;

  const transcriptTokens = contentSupportTokens(normTranscript);
  const transcriptTokenSet = new Set(transcriptTokens);
  const numericOk = numericTokens(valueTokens).every((token) => transcriptTokenSet.has(token));
  if (!numericOk) return false;

  const fullCoverage = tokenCoverage(valueTokens, transcriptTokenSet);
  if (valueTokens.length <= 2) return fullCoverage === 1;
  if (fullCoverage >= 0.62) return true;

  const windows = transcriptWindows(normTranscript);
  return windows.some((window) => {
    const windowTokenSet = new Set(contentSupportTokens(window));
    const windowNumericOk = numericTokens(valueTokens).every((token) => windowTokenSet.has(token) || transcriptTokenSet.has(token));
    return windowNumericOk && tokenCoverage(valueTokens, windowTokenSet) >= 0.55;
  });
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

const SUPPORT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "if", "in", "is", "it", "no", "not",
  "of", "on", "or", "per", "the", "then", "to", "up", "use", "with", "without", "you", "your",
]);

const CANONICAL_SUPPORT_TOKENS: Record<string, string> = {
  better: "improve",
  improving: "improve",
  improved: "improve",
  contact: "contact",
  call: "contact",
  message: "contact",
  come: "follow",
  seek: "follow",
  evaluate: "follow",
  evaluated: "follow",
  evaluation: "follow",
  return: "follow",
  recheck: "follow",
  followup: "follow",
  "follow-up": "follow",
  sooner: "follow",
  lose: "loss",
  losing: "loss",
  loss: "loss",
  unintentionally: "unintentional",
  unintentional: "unintentional",
  tobacco: "smoking",
  smoking: "smoking",
  smoke: "smoking",
  cessation: "quit",
  quit: "quit",
  quitting: "quit",
  nose: "nasal",
  nostril: "nasal",
  nostrils: "nasal",
  nasal: "nasal",
  discharge: "discharge",
  drainage: "discharge",
  stuff: "discharge",
  facial: "facial",
  face: "facial",
  cheek: "facial",
  cheeks: "facial",
  eye: "facial",
  eyes: "facial",
  maxillary: "facial",
  sinus: "facial",
  sinuses: "facial",
  belly: "abdominal",
  abdomen: "abdominal",
  abdominal: "abdominal",
  stomach: "abdominal",
  hydration: "hydration",
  hydrate: "hydration",
  fluids: "hydration",
  fluid: "hydration",
  worsening: "worsen",
  worsens: "worsen",
  worse: "worsen",
  symptom: "symptom",
  symptoms: "symptom",
  fever: "fever",
  fevers: "fever",
};

function canonicalSupportToken(token: string): string {
  if (NUMBER_WORDS[token]) return NUMBER_WORDS[token];
  const singular = token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
  return CANONICAL_SUPPORT_TOKENS[token] ?? CANONICAL_SUPPORT_TOKENS[singular] ?? singular;
}

function contentSupportTokens(text: string): string[] {
  return normalizeForHallucinationCheck(text)
    .split(/[\s.]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(canonicalSupportToken)
    .filter((token) => (token.length > 1 || /^\d+$/.test(token)) && !SUPPORT_STOPWORDS.has(token));
}

function numericTokens(tokens: string[]): string[] {
  return tokens.filter((token) => /^\d+(?:\.\d+)?$/.test(token));
}

function tokenCoverage(tokens: string[], candidate: Set<string>): number {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return 1;
  const hits = unique.filter((token) => candidate.has(token)).length;
  return hits / unique.length;
}

function transcriptWindows(normTranscript: string): string[] {
  const units = normTranscript
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map((unit) => unit.trim())
    .filter(Boolean);
  const windows = [...units];
  for (let i = 0; i < units.length - 1; i++) {
    windows.push(`${units[i]} ${units[i + 1]}`);
  }
  return windows;
}

export function evaluateCase(
  prediction: ClinicalExtraction,
  gold: ClinicalExtraction,
  transcript: string,
): { scores: FieldScores; hallucinations: HallucinationFlag[] } {
  const chiefComplaintScore = tokenSetRatio(prediction.chief_complaint, gold.chief_complaint);
  const vitalsScore = scoreVitals(prediction.vitals, gold.vitals);
  const medicationsScore = setF1(prediction.medications, gold.medications, medsMatch);
  const diagnosesScore = scoreDiagnoses(prediction.diagnoses, gold.diagnoses);
  const planScore = setF1(
    prediction.plan,
    gold.plan,
    (a, b) => tokenSetRatio(a, b) >= 0.7,
  );
  const followUpScore = scoreFollowUp(prediction.follow_up, gold.follow_up);

  const scores: FieldScores = {
    chief_complaint: chiefComplaintScore,
    vitals: vitalsScore,
    medications: medicationsScore,
    diagnoses: diagnosesScore,
    plan: planScore,
    follow_up: followUpScore,
  };

  const hallucinations: HallucinationFlag[] = [];

  // Check chief_complaint
  if (tokenSetRatio(prediction.chief_complaint, gold.chief_complaint) < 0.7 && !isInTranscript(prediction.chief_complaint, transcript)) {
    hallucinations.push({ field: "chief_complaint", value: prediction.chief_complaint });
  }

  // Check med names
  for (const med of prediction.medications) {
    if (!gold.medications.some((goldMed) => medsMatch(med, goldMed)) && !isInTranscript(med.name, transcript)) {
      hallucinations.push({ field: "medications.name", value: med.name });
    }
  }

  // Check diagnosis descriptions
  for (const diag of prediction.diagnoses) {
    if (!gold.diagnoses.some((goldDiag) => diagnosisMatchesGold(diag, goldDiag)) && !isInTranscript(diag.description, transcript)) {
      hallucinations.push({ field: "diagnoses.description", value: diag.description });
    }
  }

  // Check plan items
  for (const item of prediction.plan) {
    if (!gold.plan.some((goldItem) => tokenSetRatio(item, goldItem) >= 0.7) && !isInTranscript(item, transcript)) {
      hallucinations.push({ field: "plan", value: item });
    }
  }

  // Check follow_up reason
  if (
    prediction.follow_up.reason &&
    tokenSetRatio(prediction.follow_up.reason, gold.follow_up.reason) < 0.7 &&
    !isInTranscript(prediction.follow_up.reason, transcript)
  ) {
    hallucinations.push({ field: "follow_up.reason", value: prediction.follow_up.reason });
  }

  return { scores, hallucinations };
}

export function aggregateF1(scores: FieldScores): number {
  const values = Object.values(scores);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export { tokenSetRatio, medsMatch };
