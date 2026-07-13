import { z } from "zod";

// Fail fast and loudly on bad config — but note ANTHROPIC_API_KEY is intentionally
// optional: reviewers must be able to boot the app and run every non-LLM flow (and the
// full test suite) without a key. LLM endpoints check availability and 502 cleanly.
const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5"),
  PORT: z.coerce.number().int().positive().default(4100),
});

export const env = envSchema.parse(process.env);
export const hasLlmKey = Boolean(env.ANTHROPIC_API_KEY);
