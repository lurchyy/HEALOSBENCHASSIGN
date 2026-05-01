import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import type { ExtractionStrategy, ClinicalExtraction, AttemptLog } from "@test-evals/shared";
import { buildMessages as buildZeroShot, SYSTEM_PROMPT as ZERO_SHOT_SYSTEM } from "./strategies/zero_shot.js";
import { buildMessages as buildFewShot, SYSTEM_PROMPT as FEW_SHOT_SYSTEM } from "./strategies/few_shot.js";
import { buildMessages as buildCot, SYSTEM_PROMPT as COT_SYSTEM } from "./strategies/cot.js";

type AnthropicLike = Pick<Anthropic, "messages">;

let _client: AnthropicLike | null = null;
function getAnthropicClient(): AnthropicLike {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function setAnthropicClientForTesting(client: AnthropicLike | null): void {
  _client = client;
}

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_extraction",
  description: "Record the structured clinical extraction from the transcript.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"],
    properties: {
      chief_complaint: {
        type: "string",
        minLength: 1,
        description: "The patient's primary reason for the visit.",
      },
      vitals: {
        type: "object",
        additionalProperties: false,
        required: ["bp", "hr", "temp_f", "spo2"],
        properties: {
          bp: { type: ["string", "null"], pattern: "^[0-9]{2,3}/[0-9]{2,3}$" },
          hr: { type: ["integer", "null"], minimum: 20, maximum: 250 },
          temp_f: { type: ["number", "null"], minimum: 90, maximum: 110 },
          spo2: { type: ["integer", "null"], minimum: 50, maximum: 100 },
        },
      },
      medications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "dose", "frequency", "route"],
          properties: {
            name: { type: "string", minLength: 1 },
            dose: { type: ["string", "null"] },
            frequency: { type: ["string", "null"] },
            route: { type: ["string", "null"] },
          },
        },
      },
      diagnoses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description"],
          properties: {
            description: { type: "string", minLength: 1 },
            icd10: { type: "string", pattern: "^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$" },
          },
        },
      },
      plan: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      follow_up: {
        type: "object",
        additionalProperties: false,
        required: ["interval_days", "reason"],
        properties: {
          interval_days: { type: ["integer", "null"], minimum: 0, maximum: 730 },
          reason: { type: ["string", "null"] },
        },
      },
    },
  },
};

function getSystemPrompt(strategy: ExtractionStrategy): string {
  switch (strategy) {
    case "zero_shot":
      return ZERO_SHOT_SYSTEM;
    case "few_shot":
      return FEW_SHOT_SYSTEM;
    case "cot":
      return COT_SYSTEM;
  }
}

function buildStrategyMessages(transcript: string, strategy: ExtractionStrategy): Anthropic.MessageParam[] {
  switch (strategy) {
    case "zero_shot":
      return buildZeroShot(transcript);
    case "few_shot":
      return buildFewShot(transcript);
    case "cot":
      return buildCot(transcript);
  }
}

export function validateExtraction(data: unknown): string[] {
  const errors: string[] = [];
  if (typeof data !== "object" || data === null) {
    return ["Root must be an object"];
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.chief_complaint !== "string" || obj.chief_complaint.length < 1) {
    errors.push("chief_complaint must be a non-empty string");
  }
  if (typeof obj.vitals !== "object" || obj.vitals === null) {
    errors.push("vitals must be an object");
  } else {
    const v = obj.vitals as Record<string, unknown>;
    if (!("bp" in v)) errors.push("vitals.bp is required");
    if (!("hr" in v)) errors.push("vitals.hr is required");
    if (!("temp_f" in v)) errors.push("vitals.temp_f is required");
    if (!("spo2" in v)) errors.push("vitals.spo2 is required");
  }
  if (!Array.isArray(obj.medications)) {
    errors.push("medications must be an array");
  }
  if (!Array.isArray(obj.diagnoses)) {
    errors.push("diagnoses must be an array");
  }
  if (!Array.isArray(obj.plan)) {
    errors.push("plan must be an array");
  }
  if (typeof obj.follow_up !== "object" || obj.follow_up === null) {
    errors.push("follow_up must be an object");
  } else {
    const f = obj.follow_up as Record<string, unknown>;
    if (!("interval_days" in f)) errors.push("follow_up.interval_days is required");
    if (!("reason" in f)) errors.push("follow_up.reason is required");
  }
  return errors;
}

export async function extractClinical(
  transcript: string,
  strategy: ExtractionStrategy,
  options?: { maxRetries?: number; model?: string },
): Promise<{
  extraction: ClinicalExtraction;
  attempts: AttemptLog[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_write_input_tokens: number;
  };
}> {
  const maxRetries = options?.maxRetries ?? 3;
  const model = options?.model ?? "claude-haiku-4-5-20251001";
  const systemPrompt = getSystemPrompt(strategy);
  const messages: Anthropic.MessageParam[] = buildStrategyMessages(transcript, strategy);
  const attempts: AttemptLog[] = [];
  let totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await getAnthropicClient().messages.create({
      model,
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } },
      ],
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "any" },
      messages,
    });

    totalUsage.input_tokens += response.usage.input_tokens;
    totalUsage.output_tokens += response.usage.output_tokens;
    const usage = response.usage as unknown as Record<string, number>;
    totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    totalUsage.cache_write_input_tokens += usage.cache_creation_input_tokens ?? 0;

    const rawResponse = JSON.stringify(response.content);

    const toolUse = response.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
    if (!toolUse) {
      const log: AttemptLog = {
        attempt,
        rawResponse,
        validationErrors: ["No tool_use block in response"],
        success: false,
      };
      attempts.push(log);

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "You must call the record_extraction tool. Please try again.",
      });
      continue;
    }

    const extracted = toolUse.input as unknown;
    const errors = validateExtraction(extracted);

    if (errors.length === 0) {
      const log: AttemptLog = { attempt, rawResponse, validationErrors: null, success: true };
      attempts.push(log);
      return {
        extraction: extracted as ClinicalExtraction,
        attempts,
        usage: totalUsage,
      };
    }

    const log: AttemptLog = { attempt, rawResponse, validationErrors: errors, success: false };
    attempts.push(log);

    if (attempt < maxRetries) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Validation failed with errors:\n${errors.join("\n")}\nPlease fix these issues and call the tool again.`,
            is_error: true,
          },
        ],
      });
    }
  }

  // Return last best attempt even if invalid
  const lastAttempt = attempts.at(-1);
  if (lastAttempt) {
    const lastContent = JSON.parse(lastAttempt.rawResponse) as Anthropic.ContentBlock[];
    const lastToolUse = lastContent.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
    if (lastToolUse) {
      return {
        extraction: lastToolUse.input as ClinicalExtraction,
        attempts,
        usage: totalUsage,
      };
    }
  }

  throw new Error(`Extraction failed after ${maxRetries} attempts: ${JSON.stringify(attempts.map((a) => a.validationErrors))}`);
}

export function getPromptHash(strategy: ExtractionStrategy): string {
  const systemPrompt = getSystemPrompt(strategy);
  // Include tool definition content in hash
  const toolContent = JSON.stringify(EXTRACTION_TOOL);
  const messageTemplate = JSON.stringify(buildStrategyMessages("{{TRANSCRIPT}}", strategy));
  const content = `${strategy}:${systemPrompt}:${messageTemplate}:${toolContent}`;
  return createHash("sha256").update(content, "utf8").digest("hex");
}
