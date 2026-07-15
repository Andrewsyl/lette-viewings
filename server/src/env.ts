import { z } from "zod";

// The product operates in one timezone by design (see DESIGN.md): viewing times are
// stored as naive local time and the prompt grounds "today" in Dublin. Pinning the
// process timezone makes that assumption hold wherever the server actually runs —
// otherwise a UTC host would interpret "14:00" differently than the design intends.
// Must run before any Date is created.
process.env.TZ = process.env.TZ ?? "Europe/Dublin";

// Load server/.env if present (Node 20.12+ builtin — no dotenv dependency).
// Caught: missing file is the normal zero-config case.
try {
  process.loadEnvFile();
} catch {
  /* no .env — fine */
}

// Fail fast and loudly on bad config — but note ANTHROPIC_API_KEY is intentionally
// optional: the app must boot and run every non-LLM flow (and the
// full test suite) without a key. LLM endpoints check availability and 502 cleanly.
const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5"),
  // "mock" swaps the Anthropic client for a deterministic demo client (lib/demoLlm.ts)
  // so the full UX can be exercised with no API key. Explicit opt-in — silently mocking
  // when a key is missing would let someone mistake canned output for the real model.
  LLM_MODE: z.enum(["live", "mock"]).default("live"),
  PORT: z.coerce.number().int().positive().default(4100),
});

export const env = envSchema.parse(process.env);
export const hasLlmKey = Boolean(env.ANTHROPIC_API_KEY);

// Prisma (CLI and generated client) reads DATABASE_URL from the raw environment, not from
// this module — write the defaulted value back so "no .env file" genuinely works.
// Relative SQLite paths resolve against prisma/schema.prisma, so app and CLI agree on
// the same file (server/prisma/dev.db).
process.env.DATABASE_URL = env.DATABASE_URL;
