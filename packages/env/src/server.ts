import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    BETTER_AUTH_URL: z.url().optional(),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    ANTHROPIC_API_KEY: z.string().min(1),
    MODEL: z.string().default("claude-haiku-4-5-20251001"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
