import type { DraftStreamEvent } from "@lette/shared";
import { prisma } from "./db.js";
import { getLlmClient, type LlmClient } from "./llm.js";
import { loadDraftContext, type DraftInput } from "./draftMessages.js";
import { env } from "../env.js";

// Streaming drafts: one plain-text streamed call per lead, tokens forwarded as they
// arrive. Deliberately a different contract from parsing — structured data goes through
// the forced-tool + Zod fence (validatedToolCall.ts); this is prose bound for a human
// editor, so the fence here is the length check plus the admin's review-before-send.
// Per-lead calls keep isolation: one bad generation fails one draft, not the batch.

const MIN_LEN = 40;
const MAX_LEN = 1500;

function buildPrompts(context: Awaited<ReturnType<typeof loadDraftContext>>, lead: { id: string; name: string; notes: string | null }) {
  const system = [
    "You draft a short, warm, professional viewing invitation message for a lettings team.",
    "Address the lead by first name.",
    "Use the lead's notes for personal relevance where natural (e.g. mention parking if they asked about parking).",
    "Include: property name and address, the viewing day/time, and that spaces are limited so they should confirm.",
    "Plain text, 60–120 words. No subject line, no signature block, no placeholder brackets.",
    "Do not invent details about the property or the lead beyond what is provided.",
    "Write only the message body.",
  ].join("\n");
  const user = [
    `PROPERTY: ${context.slot.property.name} — ${context.slot.property.address}`,
    `VIEWING: ${context.when} (${context.slot.durationMins} minutes, max ${context.slot.maxAttendees} attendees)`,
    `LEAD: ${lead.name}${lead.notes ? ` — notes: ${lead.notes}` : ""}`,
  ].join("\n");
  return { system, user };
}

/** Drafts each lead's message sequentially, emitting events as tokens arrive.
 *  One lead failing (LLM error or out-of-bounds output) emits an error event for that
 *  lead and continues with the rest. */
export async function streamDraftMessages(
  input: DraftInput,
  emit: (event: DraftStreamEvent) => void,
  llm?: LlmClient
): Promise<void> {
  const client = llm ?? getLlmClient();
  const context = await loadDraftContext(input);

  for (const lead of context.leads) {
    emit({ type: "start", leadId: lead.id });
    const { system, user } = buildPrompts(context, lead);
    const started = Date.now();
    let ok = false;
    let message = "";
    let error: string | null = null;
    try {
      message = (
        await client.streamText({ system, user, maxTokens: 1024 }, (delta) =>
          emit({ type: "delta", leadId: lead.id, text: delta })
        )
      ).trim();
      if (message.length < MIN_LEN || message.length > MAX_LEN) {
        error = `draft length ${message.length} outside ${MIN_LEN}–${MAX_LEN}`;
      } else {
        ok = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    await prisma.llmCallLog.create({
      data: {
        kind: "draft_invitation_stream",
        model: env.ANTHROPIC_MODEL,
        input: user,
        rawOutput: message || null,
        parsedOk: ok,
        error,
        latencyMs: Date.now() - started,
      },
    });

    if (ok) {
      emit({ type: "done", leadId: lead.id, message });
    } else {
      emit({ type: "error", leadId: lead.id, message: "Couldn't draft this message — try again or write it manually." });
    }
  }
  emit({ type: "complete" });
}
