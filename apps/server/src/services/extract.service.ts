import { readFileSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { extractClinical } from "@test-evals/llm";
import type { ExtractionStrategy, ClinicalExtraction, AttemptLog } from "@test-evals/shared";

type ValidateFn = (data: unknown) => boolean;
let schemaValidator: ValidateFn | null = null;

function getValidator(): ValidateFn {
  if (!schemaValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemaPath = process.env.DATA_DIR
      ? resolve(process.env.DATA_DIR, "schema.json")
      : resolve(process.cwd(), "data", "schema.json");
    const rawSchema = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(rawSchema) as Record<string, unknown>;
    // Remove $schema key so ajv doesn't try to resolve the draft URI
    delete schema["$schema"];
    schemaValidator = ajv.compile(schema) as ValidateFn;
  }
  return schemaValidator;
}

export async function extract(
  transcript: string,
  strategy: ExtractionStrategy,
  model: string,
  options?: { maxRetries?: number },
): Promise<{
  extraction: ClinicalExtraction;
  attempts: AttemptLog[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_write_input_tokens: number;
  };
  isSchemaValid: boolean;
}> {
  const result = await extractClinical(transcript, strategy, { ...options, model });
  const validate = getValidator();
  const isSchemaValid = validate(result.extraction);
  return { ...result, isSchemaValid };
}
