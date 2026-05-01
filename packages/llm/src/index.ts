export { extractClinical, getPromptHash, setAnthropicClientForTesting, validateExtraction } from "./client.js";
export { buildMessages as buildZeroShotMessages } from "./strategies/zero_shot.js";
export { buildMessages as buildFewShotMessages } from "./strategies/few_shot.js";
export { buildMessages as buildCotMessages } from "./strategies/cot.js";
