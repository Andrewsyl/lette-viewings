import type { z } from "zod";
import { prisma } from "./db.js";
import type { LlmClient, ToolSpec } from "./llm.js";
import { LlmOutputError } from "./errors.js";
import { env } from "../env.js";

// The fence, in one place: forced tool call → Zod semantic validation → ONE repair retry
// (validation errors fed back verbatim) → audit log → friendly 422. Both LLM features go
// through this — a model that fails twice on the same input is telling you something a
// third attempt won't fix.

export interface ValidatedToolCallOptions<S extends z.ZodTypeAny> {
  client: LlmClient;
  /** Audit log kind, e.g. "parse_slots" */
  kind: string;
  system: string;
  user: string;
  tool: ToolSpec;
  schema: S;
  maxTokens?: number;
  /** Extra guidance appended to the repair prompt, e.g. "use clarifications instead". */
  repairHint?: string;
  /** Human-readable message for the 422 when the model fails twice. */
  friendlyError: string;
}

export async function invokeWithValidation<S extends z.ZodTypeAny>(
  opts: ValidatedToolCallOptions<S>
): Promise<z.infer<S>> {
  const started = Date.now();

  let attempt = await opts.client.invokeTool({
    system: opts.system,
    user: opts.user,
    tool: opts.tool,
    maxTokens: opts.maxTokens,
  });
  let parsed = opts.schema.safeParse(attempt.input);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    attempt = await opts.client.invokeTool({
      system: opts.system,
      user:
        `${opts.user}\n\n` +
        `Your previous attempt failed validation with these errors: ${issues}. ` +
        `Return a corrected tool call.${opts.repairHint ? ` ${opts.repairHint}` : ""}`,
      tool: opts.tool,
      maxTokens: opts.maxTokens,
    });
    parsed = opts.schema.safeParse(attempt.input);
  }

  await prisma.llmCallLog.create({
    data: {
      kind: opts.kind,
      model: env.ANTHROPIC_MODEL,
      input: opts.user,
      rawOutput: attempt.raw,
      parsedOk: parsed.success,
      error: parsed.success ? null : JSON.stringify(parsed.error.issues),
      latencyMs: Date.now() - started,
    },
  });

  if (!parsed.success) {
    throw new LlmOutputError(opts.friendlyError, parsed.error.issues);
  }
  return parsed.data;
}
