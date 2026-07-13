import { z } from "zod";
import { prisma } from "./db.js";
import { getLlmClient, type LlmClient, type ToolSpec } from "./llm.js";
import { invokeWithValidation } from "./validatedToolCall.js";
import { NotFoundError } from "./errors.js";

// Drafts personalised invitation messages for a slot's leads, through the shared fence
// (validatedToolCall.ts). Drafts are returned to the admin for review/editing — they are
// NOT saved here. The admin-approved text is what gets persisted (via the approve
// endpoint), keeping a human between the model and anything an invitee ever sees.

const TOOL: ToolSpec = {
  name: "draft_invitations",
  description:
    "Draft a personalised viewing invitation message for each lead, using the property " +
    "details and what is known about the lead.",
  inputSchema: {
    type: "object",
    properties: {
      drafts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            leadId: { type: "string", description: "Must be an id from the provided lead list" },
            message: { type: "string", description: "The invitation message body, plain text" },
          },
          required: ["leadId", "message"],
        },
      },
    },
    required: ["drafts"],
  },
};

function buildDraftSchema(expectedLeadIds: string[]) {
  const expected = new Set(expectedLeadIds);
  return z
    .object({
      drafts: z.array(
        z.object({
          leadId: z.string().refine((id) => expected.has(id), { message: "leadId was not in the requested list" }),
          message: z.string().min(40).max(1500),
        })
      ),
    })
    .refine((data) => new Set(data.drafts.map((d) => d.leadId)).size === expectedLeadIds.length, {
      message: "exactly one draft per requested lead is required",
    });
}

export interface DraftInput {
  slotId: string;
  leadIds: string[];
}

export async function draftInvitationMessages(input: DraftInput, llm?: LlmClient) {
  const client = llm ?? getLlmClient();

  const slot = await prisma.viewingSlot.findUnique({
    where: { id: input.slotId },
    include: { property: true },
  });
  if (!slot) throw new NotFoundError("Viewing slot not found");

  const leads = await prisma.lead.findMany({ where: { id: { in: input.leadIds } } });
  if (leads.length !== input.leadIds.length) throw new NotFoundError("One or more leads not found");

  const when = slot.startsAt.toLocaleString("en-IE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const system = [
    "You draft short, warm, professional viewing invitation messages for a lettings team.",
    "One message per lead. Address the lead by first name.",
    "Use the lead's notes for personal relevance where natural (e.g. mention parking if they asked about parking).",
    "Include: property name and address, the viewing day/time, and that spaces are limited so they should confirm.",
    "Plain text, 60–120 words. No subject line, no signature block, no placeholder brackets.",
    "Do not invent details about the property or the lead beyond what is provided.",
  ].join("\n");

  const user = [
    `PROPERTY: ${slot.property.name} — ${slot.property.address}`,
    `VIEWING: ${when} (${slot.durationMins} minutes, max ${slot.maxAttendees} attendees)`,
    "",
    "LEADS:",
    ...leads.map((l) => `- ${l.id}: ${l.name}${l.notes ? ` — notes: ${l.notes}` : ""}`),
  ].join("\n");

  const result = await invokeWithValidation({
    client,
    kind: "draft_invitations",
    system,
    user,
    tool: TOOL,
    schema: buildDraftSchema(input.leadIds),
    maxTokens: 4096,
    friendlyError: "Couldn't draft messages for this slot — please try again.",
  });

  return result.drafts;
}
