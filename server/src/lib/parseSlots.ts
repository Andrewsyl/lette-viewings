import { z } from "zod";
import type { SlotProposal } from "@lette/shared";
import { prisma } from "./db.js";
import { getLlmClient, type LlmClient, type ToolSpec } from "./llm.js";
import { invokeWithValidation } from "./validatedToolCall.js";

// NL → structured slot proposal, through the shared fence (validatedToolCall.ts):
// forced tool call → Zod semantic validation → one repair retry → 422.
// Nothing here writes slots or invitations; /parse is phase 1 of a two-phase create and
// persists only the audit log entry.

const TOOL: ToolSpec = {
  name: "propose_viewing_slots",
  description:
    "Propose viewing slots and invitees parsed from the property manager's request. " +
    "If anything important is ambiguous or missing, ask via `clarifications` instead of guessing.",
  inputSchema: {
    type: "object",
    properties: {
      slots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            propertyId: { type: "string", description: "Must be an id from the provided property list" },
            date: { type: "string", description: "YYYY-MM-DD" },
            startTime: { type: "string", description: "HH:MM, 24-hour" },
            durationMins: { type: "integer" },
            maxAttendees: { type: "integer" },
          },
          required: ["propertyId", "date", "startTime", "durationMins", "maxAttendees"],
        },
      },
      inviteeLeadIds: {
        type: "array",
        items: { type: "string", description: "Must be ids from the provided lead list" },
      },
      clarifications: {
        type: "array",
        items: { type: "string" },
        description:
          "Questions for the admin when the request is ambiguous (vague dates, unknown people, missing counts). " +
          "If non-empty, slots/invitees may be partial or empty — the admin will answer and retry.",
      },
    },
    required: ["slots", "inviteeLeadIds", "clarifications"],
  },
};

// Semantic validation the JSON schema can't express: real ids, future dates, sane bounds.
function buildProposalSchema(validPropertyIds: Set<string>, validLeadIds: Set<string>, now: Date) {
  return z.object({
    slots: z.array(
      z.object({
        propertyId: z
          .string()
          .refine((id) => validPropertyIds.has(id), { message: "propertyId is not in the provided property list" }),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "startTime must be HH:MM (24h)"),
        durationMins: z.number().int().min(5).max(240),
        maxAttendees: z.number().int().min(1).max(50),
      })
        .refine(
          (slot) => new Date(`${slot.date}T${slot.startTime}:00`) > now,
          { message: "slot start must be in the future" }
        )
    ),
    inviteeLeadIds: z.array(
      z.string().refine((id) => validLeadIds.has(id), { message: "leadId is not in the provided lead list" })
    ),
    clarifications: z.array(z.string().min(1)).max(5),
  });
}

function buildSystemPrompt(
  today: string,
  properties: { id: string; name: string; address: string }[],
  leads: { id: string; name: string; notes: string | null }[]
) {
  return [
    "You parse a property manager's natural-language request into structured viewing slots.",
    `Today is ${today} (Europe/Dublin). All dates are in the future relative to today.`,
    "",
    "PROPERTIES (use these ids only):",
    ...properties.map((p) => `- ${p.id}: ${p.name} — ${p.address}`),
    "",
    "LEADS (use these ids only):",
    ...leads.map((l) => `- ${l.id}: ${l.name}${l.notes ? ` (${l.notes})` : ""}`),
    "",
    "Rules:",
    "- Never invent property or lead ids. If the request names someone not in the list, add a clarification.",
    "- If a date/time is vague (e.g. 'sometime next week'), ask via clarifications rather than guessing.",
    "- 'afternoon' means slots between 13:00 and 17:00; 'morning' 09:00–12:00; 'evening' 17:00–20:00.",
    "- Multiple slots in one afternoon should be consecutive unless told otherwise.",
    "- Defaults when unstated: duration 30 minutes, maxAttendees 5 — do NOT ask about these.",
    "- Asking about something genuinely ambiguous is always better than guessing wrong.",
  ].join("\n");
}

export interface ParseResult {
  proposal: SlotProposal;
  properties: { id: string; name: string; address: string }[];
  leads: { id: string; name: string; email: string; notes: string | null }[];
}

export async function parseSlotRequest(text: string, llm?: LlmClient): Promise<ParseResult> {
  const client = llm ?? getLlmClient();
  const [properties, leads] = await Promise.all([
    prisma.property.findMany(),
    prisma.lead.findMany(),
  ]);

  const now = new Date();
  const proposal = await invokeWithValidation({
    client,
    kind: "parse_slots",
    system: buildSystemPrompt(now.toISOString().slice(0, 10), properties, leads),
    user: text,
    tool: TOOL,
    schema: buildProposalSchema(
      new Set(properties.map((p) => p.id)),
      new Set(leads.map((l) => l.id)),
      now
    ),
    repairHint: "If you cannot satisfy a constraint, use clarifications instead.",
    friendlyError:
      "I couldn't reliably interpret that request — try rephrasing with a specific property, date and time.",
  });

  return { proposal, properties, leads };
}
