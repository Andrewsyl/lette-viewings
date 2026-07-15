import { z } from "zod";
import type { SlotProposal, SlotWithCounts } from "@lette/shared";
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
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "When the answer is one of a few discrete choices (2-6), list them so the UI can offer one-tap answers: weekdays for vague dates, morning/afternoon/evening for times, lead names when asking who to invite. Omit only for open-ended questions.",
            },
            multiple: {
              type: "boolean",
              description:
                "true when several options may be picked together (e.g. which leads to invite) — the admin's answer may then be a comma-separated list.",
            },
          },
          required: ["question"],
        },
        description:
          "Questions for the admin when the request is ambiguous (vague dates, unknown people, missing counts). " +
          "If non-empty, slots/invitees may be partial or empty — the admin will answer and retry.",
      },
      assumptions: {
        type: "array",
        items: { type: "string" },
        description:
          "Short notes (one line each) for every interpretation you made that the admin might want to check: " +
          "vague words resolved ('afternoon' → starting 14:00), defaults applied (30 min, max 5), consecutive scheduling. " +
          "Plain English only — never internal ids (say '22 Maple Street', never 'prop_maple'). Only note things " +
          "the request left open: never claim something was unspecified when the admin stated it.",
      },
      reply: {
        type: "string",
        description:
          "Conversational answer when the latest message is a question or not a scheduling instruction " +
          "('what's booked on Tuesday?', 'can you delete viewings?'). Answer from ALREADY BOOKED and " +
          "say what you can do. A pure question gets a reply and nothing proposed; a question asked " +
          "while an earlier instruction still stands gets BOTH the reply and the proposal — never " +
          "leave such a question unanswered.",
      },
      window: {
        type: "object",
        properties: {
          earliest: { type: "string", description: "HH:MM — earliest acceptable start per the admin's words" },
          latest: { type: "string", description: "HH:MM — everything must END by this time" },
        },
        required: ["earliest", "latest"],
        description:
          "The time range the admin's words allow. 'afternoon' → 13:00–17:00, 'morning' → 09:00–12:00, " +
          "'evening' → 17:00–20:00, an explicit time → from that time, wide enough to fit everything proposed " +
          "plus an hour of flex; no time mentioned → 13:00–19:00.",
      },
      corrections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "The exact text from the request that looks like a typo" },
            to: { type: "string", description: "The lead's real name it should be replaced with" },
          },
          required: ["from", "to"],
        },
        description:
          "When a clarification is a 'Did you mean…?' typo suggestion, also provide the machine-usable fix here.",
      },
      cancelSlotIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Existing viewings the admin asked to cancel — ids from the ALREADY BOOKED list only. " +
          "Cancel exactly what was asked, nothing more.",
      },
      reschedules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slotId: { type: "string", description: "Id from the ALREADY BOOKED list" },
            date: { type: "string", description: "YYYY-MM-DD — the new date" },
            startTime: { type: "string", description: "HH:MM 24h — the new start time" },
          },
          required: ["slotId", "date", "startTime"],
        },
        description: "Existing viewings the admin asked to move, with their new date/time.",
      },
    },
    required: ["slots", "inviteeLeadIds", "clarifications", "assumptions", "window"],
  },
};

// Semantic validation the JSON schema can't express: real ids, future dates, sane bounds.
function buildProposalSchema(
  validPropertyIds: Set<string>,
  validLeadIds: Set<string>,
  validSlotIds: Set<string>,
  now: Date
) {
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
    inviteeLeadIds: z
      .array(
        z.string().refine((id) => validLeadIds.has(id), { message: "leadId is not in the provided lead list" })
      )
      // Models repeat an id ("invite Murphy" against two slots → Murphy twice); a preview
      // saying "inviting Conor and Conor" is absurd, so uniqueness is enforced here.
      .transform((ids) => [...new Set(ids)]),
    clarifications: z
      .array(
        z.object({
          question: z.string().min(1),
          options: z.array(z.string().min(1)).min(2).max(6).optional(),
          multiple: z.boolean().optional(),
        })
      )
      .max(5),
    assumptions: z.array(z.string().min(1)).max(8).optional().default([]),
    reply: z.string().min(1).max(800).optional(),
    window: z
      .object({
        earliest: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        latest: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .refine((w) => w.latest > w.earliest, { message: "window.latest must be after window.earliest" })
      .optional(),
    corrections: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .max(5)
      .optional()
      .default([]),
    cancelSlotIds: z
      .array(
        z.string().refine((id) => validSlotIds.has(id), { message: "cancelSlotIds refers to a viewing not in the booked list" })
      )
      .max(20)
      .transform((ids) => [...new Set(ids)])
      .optional()
      .default([]),
    reschedules: z
      .array(
        z
          .object({
            slotId: z
              .string()
              .refine((id) => validSlotIds.has(id), { message: "reschedules refers to a viewing not in the booked list" }),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
            startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "startTime must be HH:MM (24h)"),
          })
          .refine((r) => new Date(`${r.date}T${r.startTime}:00`) > now, {
            message: "rescheduled start must be in the future",
          })
      )
      .max(20)
      .optional()
      .default([]),
  });
}

function buildSystemPrompt(
  now: Date,
  properties: { id: string; name: string; address: string }[],
  leads: { id: string; name: string; notes: string | null }[],
  upcoming: { id: string; propertyId: string; startsAt: Date; durationMins: number }[]
) {
  // Models are unreliable at weekday arithmetic — a wrong "Monday 21 July" in an option
  // chip is a trust-destroying bug. Ground the next two weeks explicitly instead.
  const calendar = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
    const weekday = d.toLocaleDateString("en-IE", { weekday: "long", timeZone: "Europe/Dublin" });
    return `- ${weekday} ${d.toISOString().slice(0, 10)}`;
  });
  const today = now.toISOString().slice(0, 10);
  const todayName = now.toLocaleDateString("en-IE", { weekday: "long", timeZone: "Europe/Dublin" });
  const timeOpts = { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Dublin" } as const;
  const bookedLines = upcoming.map((s) => {
    const end = new Date(s.startsAt.getTime() + s.durationMins * 60_000);
    const day = s.startsAt.toLocaleDateString("en-IE", { weekday: "long", timeZone: "Europe/Dublin" });
    return `- ${s.id} | ${s.propertyId}: ${day} ${s.startsAt.toISOString().slice(0, 10)} ${s.startsAt.toLocaleTimeString("en-IE", timeOpts)}–${end.toLocaleTimeString("en-IE", timeOpts)}`;
  });
  return [
    "You are Vera, Lette's scheduling assistant, working alongside a property management team.",
    "You speak in the first person — warm, brisk, plain English. Your questions and assumptions should read like a helpful colleague, never like a system.",
    "You parse the property manager's natural-language request into structured viewing slots.",
    `Today is ${todayName} ${today} (Europe/Dublin). All dates are in the future relative to today.`,
    "",
    "ALREADY BOOKED — upcoming viewings that exist (do not double-book on top of these):",
    ...(bookedLines.length > 0 ? bookedLines : ["- none yet"]),
    "",
    "CALENDAR for the next two weeks (use these weekday↔date pairings, never compute your own):",
    ...calendar,
    "",
    "PROPERTIES (use these ids only):",
    ...properties.map((p) => `- ${p.id}: ${p.name} — ${p.address}`),
    "",
    "LEADS (use these ids only):",
    ...leads.map((l) => `- ${l.id}: ${l.name}${l.notes ? ` (${l.notes})` : ""}`),
    "",
    "Rules:",
    "- The request text may hold several turns of one exchange: the original request first, then lines like 'Clarification — \"<question>\": <answer>' and follow-up messages appended below it. The LAST line is what the admin just said — respond to that, treating everything above as context you have already handled. Never re-answer an earlier line, never repeat a previous reply, and never claim the admin didn't specify something they answered in a clarification line — an answered question is settled.",
    "- Never invent property or lead ids. If the request names someone not in the list, add a clarification.",
    "- Cancelling or moving existing viewings: use `cancelSlotIds` / `reschedules` with ids from ALREADY BOOKED. Touch exactly what the admin asked — never more. If their reference matches nothing, or could match several viewings, ask via clarifications (offer the candidates as options). A cancel/move request creates no new slots unless the admin also asked for them.",
    "- NOTHING happens until the admin confirms the preview. Phrase assumptions as intentions ('I'll cancel the three Tuesday viewings'), never as completed actions ('are cancelled') — claiming something happened before it did destroys trust.",
    "- If the request is a question or not a scheduling instruction ('can you delete viewings?', 'what's booked on Tuesday?', 'list viewings'), answer it in `reply` — grounded in ALREADY BOOKED, short and helpful, mentioning what to say next ('Yes — just tell me which viewings to cancel'). Propose nothing and ask nothing alongside it.",
    "- Exception: when the latest line asks a question but an instruction from earlier lines still stands ('wait, will this send two invites to the same person?'), answer the question in `reply` AND keep proposing — the answer belongs in `reply`, never in assumptions (assumptions are for your interpretations, not for answering the admin). Never let a question silently drop the plan, and never let the plan silently drop the question.",
    "- Invitees: each lead appears in `inviteeLeadIds` exactly ONCE — every listed lead is invited to every proposed viewing, one invitation per viewing. So 'invite Murphy' to two viewings means Murphy gets two invitations, one per time, and accepts whichever suits. Use exactly this when asked who gets invited to what.",
    "- `reply` renders as plain text in a chat bubble: no markdown or bullet syntax, and never internal ids — say '22 Maple Street', never 'prop_maple'. Keep long lists to a friendly summary (per day or per property).",
    "- 'List' or 'what's on' requests get the actual viewings in `reply` — property, day and times from ALREADY BOOKED (e.g. 'Tomorrow, Wednesday 16 July, has one viewing: 9 Botanic View at 2:00pm.') — never a description of what you could do instead.",
    "- A polite question that contains a complete instruction ('Can you cancel Tuesday's viewings at Maple Street?') IS an instruction — propose the operations, don't just talk about them.",
    "- A misspelled name that clearly matches exactly ONE lead: use that lead's id (the admin confirms in the preview).",
    "- A name that could match multiple leads, or none closely: ask via clarifications ('Did you mean <full name>?')" +
      " AND emit the machine-usable fix in `corrections` ({from: the typed text, to: the lead's full name}).",
    "- Never silently drop a person the request asked to invite — an unmatched person is always a clarification.",
    "- If a date is vague (e.g. 'sometime next week'), ask via clarifications rather than guessing. 'Next week' means the week beginning next Monday — offer options from that week (see CALENDAR), not the current one.",
    "- If the request contradicts itself, NEVER silently pick one reading. 'Saturday the 27th' when the CALENDAR shows the 27th is a Monday gets a question naming both readings, with both as options: 'Just to check — next Saturday is the 25th, and the 27th is a Monday. Which did you mean?' options ['Saturday 25 July', 'Monday 27 July'].",
    "- Always return `window`: the start–end range the admin's words allow. Slots must start and end inside it — the system moves slots within the window to avoid clashes, but never outside it.",
    "- When ALREADY BOOKED has entries at the requested property on the requested day, don't state exact start times in assumptions (they may be adjusted to avoid clashes) — describe the window instead ('three 30-minute viewings in the afternoon').",
    "- A time that is simply unmentioned is NOT a question: default to afternoon starting 14:00 and record it in assumptions. Only ask about time when the admin's own wording makes the time ambiguous.",
    "- Never output a slot in `slots` that overlaps an ALREADY BOOKED viewing at the same property — a clashing slot must not reach the preview. When the admin left you room to move, schedule around the existing viewings and say so in assumptions. When they asked for a specific clashing time, leave the slot out and ask via `clarifications`, offering the nearest free times as options. A clash question belongs in clarifications, never in assumptions.",
    "- Ask ONE clarifying question per turn — the most blocking one first (property, then day, then who to invite, then times). The admin's answer comes back appended to the request, and you can ask the next question then. Never stack multiple questions in one turn.",
    "- Every question whose answer set is small MUST include `options` (2–6) so the admin can answer with one tap: weekday choices for a vague date, 'morning'/'afternoon'/'evening' for a vague time, and the lead names from the roster when asking who to invite. Omit options only for genuinely open-ended questions. Set `multiple: true` when several options can be picked together (who to invite); the answer may then be a comma-separated list.",
    "- 'afternoon' means slots between 13:00 and 17:00; 'morning' 09:00–12:00; 'evening' 17:00–20:00.",
    "- Multiple slots in one afternoon should be consecutive unless told otherwise.",
    "- Defaults when unstated: duration 30 minutes, maxAttendees 5 — do NOT ask about these.",
    "- Record every judgement call in `assumptions` so the admin can check your reading at a glance: vague words you resolved, defaults you applied, consecutive scheduling. Write each as one short, friendly first-person sentence — 'I read \"afternoon\" as starting at 2pm.', 'You didn't give a duration, so I went with 30 minutes.' — they are shown as you speaking. Use natural dates and times ('Tuesday 21 July', '2pm'), never ISO formats. An empty list means the request was fully explicit.",
    "- Asking about something genuinely ambiguous is always better than guessing wrong.",
  ].join("\n");
}

// --- Deterministic clash fence ---------------------------------------------------
// Interval arithmetic is not a job for a language model. The prompt grounds what's
// already booked so the model can schedule around it gracefully — but the guarantee
// that no double-booking reaches the preview is enforced here, in code. Repair-first:
// a clashing slot is moved to the nearest free time and the move is spoken in
// assumptions (the preview is the human gate — the admin sees the new times and can
// push back). Questions are reserved for the case with no room left in the day —
// interrogating the admin about clashes we can solve ourselves is just rude.

type BookedSlot = { id: string; propertyId: string; startsAt: Date; durationMins: number };

// Naive local time by design (see DESIGN.md) — same construction the Zod refine uses.
function slotStart(slot: { date: string; startTime: string }): Date {
  return new Date(`${slot.date}T${slot.startTime}:00`);
}

function overlaps(aStart: Date, aMins: number, bStart: Date, bMins: number): boolean {
  return (
    aStart.getTime() < bStart.getTime() + bMins * 60_000 &&
    bStart.getTime() < aStart.getTime() + aMins * 60_000
  );
}

function friendlyTime(d: Date): string {
  // hourCycle h12, not hour12:true — Node resolves en-IE's 12-hour cycle to h11,
  // which renders noon as "0:00pm" in the admin's options. Seen live.
  return d
    .toLocaleTimeString("en-IE", { hour: "numeric", minute: "2-digit", hourCycle: "h12" })
    .replace(/[\s.]/g, "")
    .toLowerCase();
}

function friendlyDay(d: Date): string {
  return d.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
}

function mergeRanges(ranges: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  const sorted = [...ranges].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: { start: Date; end: Date }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start.getTime() <= last.end.getTime()) {
      if (r.end.getTime() > last.end.getTime()) last.end = r.end;
    } else {
      out.push({ start: new Date(r.start), end: new Date(r.end) });
    }
  }
  return out;
}

function repairClashes(
  proposal: SlotProposal,
  booked: BookedSlot[],
  properties: { id: string; name: string }[]
): SlotProposal {
  const reschedules = proposal.reschedules ?? [];
  if (proposal.clarifications.length > 0 || (proposal.slots.length === 0 && reschedules.length === 0)) {
    return proposal;
  }

  // The admin's stated time range is a hard boundary: repairs move slots freely INSIDE
  // it, but going outside it isn't a repair — it's a different offer, which needs the
  // admin's consent (the trade-off question below). Fallback window for a model that
  // omitted one: generous business hours.
  const window = proposal.window ?? { earliest: "08:00", latest: "20:00" };
  const windowBounds = (date: string) => ({
    start: new Date(`${date}T${window.earliest}:00`).getTime(),
    end: new Date(`${date}T${window.latest}:00`).getTime(),
  });

  // Viewings being cancelled or moved free up their old times before anything is placed.
  const removedIds = new Set([...(proposal.cancelSlotIds ?? []), ...reschedules.map((r) => r.slotId)]);

  type Placed = { start: Date; mins: number; propertyId: string };
  const placed: Placed[] = booked
    .filter((b) => !removedIds.has(b.id))
    .map((b) => ({ start: b.startsAt, mins: b.durationMins, propertyId: b.propertyId }));
  const isFree = (start: Date, mins: number, propertyId: string) =>
    !placed.some((p) => p.propertyId === propertyId && overlaps(start, mins, p.start, p.mins));

  // Reschedule targets are explicit instructions — fixed placements, never auto-moved.
  // A clashing target is the admin's call: ask, with the nearest free times that day.
  for (const r of reschedules) {
    const origin = booked.find((b) => b.id === r.slotId);
    if (!origin) continue; // Zod guarantees this; belt and braces
    const target = new Date(`${r.date}T${r.startTime}:00`);
    if (isFree(target, origin.durationMins, origin.propertyId)) {
      placed.push({ start: target, mins: origin.durationMins, propertyId: origin.propertyId });
      continue;
    }
    const name = properties.find((p) => p.id === origin.propertyId)?.name ?? "the property";
    const dayEnd = new Date(`${r.date}T21:30:00`).getTime();
    const suggestions: string[] = [];
    for (let t = target.getTime(); t <= dayEnd && suggestions.length < 2; t += 30 * 60_000) {
      const candidate = new Date(t);
      if (isFree(candidate, origin.durationMins, origin.propertyId)) suggestions.push(friendlyTime(candidate));
    }
    return {
      ...proposal,
      slots: [],
      clarifications: [
        {
          question:
            `${name} already has a viewing at ${friendlyTime(target)} on ${friendlyDay(target)}, so I can't ` +
            `move it there.${suggestions.length > 0 ? ` The nearest free ${suggestions.length > 1 ? "times are" : "time is"} ${suggestions.join(" and ")}.` : ""} What would suit?`,
          ...(suggestions.length > 0 ? { options: [...suggestions, "Another day"] } : {}),
        },
      ],
    };
  }

  const unplaceable: SlotProposal["slots"] = [];
  const repaired: SlotProposal["slots"] = [];
  // Properties/days where a move happened — their booked ranges get spoken back.
  const movedAt = new Set<string>();
  // Original start times of moved slots — any model assumption still narrating one of
  // these ("back-to-back at 2pm, 2:30pm and 3pm") is stale the moment we repair, and a
  // preview that says one time while the cards show another destroys trust.
  const movedFrom: Date[] = [];
  let anyMoved = false;

  // Chronological order so repaired slots pack after each other, not on top of each other.
  const ordered = [...proposal.slots].sort((a, b) => slotStart(a).getTime() - slotStart(b).getTime());
  const STEP = 30 * 60_000;

  for (const slot of ordered) {
    const originalStart = slotStart(slot);
    const bounds = windowBounds(slot.date);
    let start: Date | null = null;

    if (isFree(originalStart, slot.durationMins, slot.propertyId)) {
      start = originalStart; // what was asked for is available — never move it
    } else {
      // First free start on a 30-minute grid inside the window, earliest first.
      for (let t = bounds.start; t + slot.durationMins * 60_000 <= bounds.end; t += STEP) {
        const candidate = new Date(t);
        if (isFree(candidate, slot.durationMins, slot.propertyId)) {
          start = candidate;
          break;
        }
      }
    }

    if (!start) {
      unplaceable.push(slot);
      continue;
    }
    if (start.getTime() !== originalStart.getTime()) {
      anyMoved = true;
      movedAt.add(`${slot.propertyId}|${slot.date}`);
      movedFrom.push(originalStart);
    }
    const hh = String(start.getHours()).padStart(2, "0");
    const mm = String(start.getMinutes()).padStart(2, "0");
    repaired.push({ ...slot, startTime: `${hh}:${mm}` });
    placed.push({ start, mins: slot.durationMins, propertyId: slot.propertyId });
  }

  if (!anyMoved && unplaceable.length === 0) return proposal;

  // Matches the time in any voice the model uses: "14:00", "9:00" bare, "2pm"/"2:00 pm".
  // The lookarounds stop "2:00" swallowing the tail of "12:00" or the head of "2:005".
  const timeMention = (d: Date) => {
    const h24 = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const h12 = ((d.getHours() + 11) % 12) + 1;
    const minutePart = d.getMinutes() === 0 ? "(?:[:.]00)?" : `[:.]${mm}`;
    return new RegExp(
      `(?<!\\d)(?:${h24}:${mm}(?!\\d)|${h12}[:.]${mm}(?!\\d)|${h12}${minutePart}\\s?[ap]\\.?m)`,
      "i"
    );
  };
  const staleTimes = movedFrom.map(timeMention);
  const assumptions = proposal.assumptions.filter((a) => !staleTimes.some((re) => re.test(a)));
  for (const key of movedAt) {
    const [propertyId, date] = key.split("|") as [string, string];
    const dayRanges = booked
      .filter((b) => b.propertyId === propertyId && b.startsAt.toISOString().slice(0, 10) === new Date(`${date}T12:00:00`).toISOString().slice(0, 10))
      .map((b) => ({ start: b.startsAt, end: new Date(b.startsAt.getTime() + b.durationMins * 60_000) }));
    if (dayRanges.length === 0) continue;
    const merged = mergeRanges(dayRanges);
    const name = properties.find((p) => p.id === propertyId)?.name ?? "The property";
    assumptions.push(
      `${name} is already booked ${merged
        .map((r) => `${friendlyTime(r.start)}–${friendlyTime(r.end)}`)
        .join(" and ")} on ${friendlyDay(merged[0]!.start)}, so I scheduled around that.`
    );
  }

  const clarifications = [...proposal.clarifications];
  if (unplaceable.length > 0) {
    // The window can't fit the request — that's a trade-off only the admin can make.
    // Offer the nearest free times AFTER the window that day, plus the escape hatch.
    const firstLost = unplaceable[0]!;
    const bounds = windowBounds(firstLost.date);
    const name = properties.find((p) => p.id === firstLost.propertyId)?.name ?? "the property";
    const dayEnd = new Date(`${firstLost.date}T21:30:00`).getTime();
    const suggestions: string[] = [];
    for (let t = bounds.end; t <= dayEnd && suggestions.length < 2; t += STEP) {
      const candidate = new Date(t);
      if (isFree(candidate, firstLost.durationMins, firstLost.propertyId)) {
        suggestions.push(friendlyTime(candidate));
      }
    }
    if (suggestions.length > 0) {
      clarifications.push({
        question:
          `${name} is fully booked on ${friendlyDay(slotStart(firstLost))} within the time you asked for — ` +
          `the nearest free ${suggestions.length > 1 ? "times are" : "time is"} ${suggestions.join(" and ")} ` +
          `later that day. Take ${suggestions.length > 1 ? "one of those" : "it"}, or try another day?`,
        options: [...suggestions, "Another day"],
      });
    } else {
      clarifications.push({
        question:
          `${name} is heavily booked on ${friendlyDay(slotStart(firstLost))} — I couldn't fit ` +
          `${unplaceable.length === proposal.slots.length ? "the viewings" : "all the viewings"} around ` +
          `the existing ones. Which day should I try instead?`,
      });
    }
  }

  return { ...proposal, slots: repaired, clarifications, assumptions };
}

export interface ParseResult {
  proposal: SlotProposal;
  properties: { id: string; name: string; address: string }[];
  leads: { id: string; name: string; email: string; notes: string | null }[];
  /** Current details of viewings referenced by cancel/reschedule, for the preview. */
  existingSlots?: SlotWithCounts[];
}

export async function parseSlotRequest(text: string, llm?: LlmClient): Promise<ParseResult> {
  const client = llm ?? getLlmClient();
  const now = new Date();
  const [properties, leads, upcoming] = await Promise.all([
    prisma.property.findMany(),
    prisma.lead.findMany(),
    // Ground what's already booked so the model can avoid or surface clashes — capped
    // because prompt space is a budget; nearest-first is the relevant order.
    prisma.viewingSlot.findMany({
      where: { startsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
      take: 40,
      select: { id: true, propertyId: true, startsAt: true, durationMins: true },
    }),
  ]);
  const invokeOpts = {
    client,
    kind: "parse_slots",
    system: buildSystemPrompt(now, properties, leads, upcoming),
    user: text,
    tool: TOOL,
    schema: buildProposalSchema(
      new Set(properties.map((p) => p.id)),
      new Set(leads.map((l) => l.id)),
      new Set(upcoming.map((s) => s.id)),
      now
    ),
    repairHint: "If you cannot satisfy a constraint, use clarifications instead.",
    friendlyError:
      "I couldn't reliably interpret that request — try rephrasing with a specific property, date and time.",
  };
  let raw = await invokeWithValidation(invokeOpts);

  // Soft guarantee, enforced by retry: a follow-up question mid-exchange ("wait, will
  // this send two invites to the same person?") must get a spoken answer, not narration
  // buried in assumptions. The prompt asks for `reply` here, but Haiku only complies
  // about half the time — so when the latest line is a question and no reply came back,
  // ask once more with that as the correction. Soft, unlike the fence above: a valid
  // plan missing its answer ships anyway rather than failing the whole request.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const latest = lines[lines.length - 1] ?? "";
  const isFollowUpQuestion =
    lines.length > 1 && /\?\s*$/.test(latest) && !latest.startsWith("Clarification —");
  const actionCount = raw.slots.length + raw.cancelSlotIds.length + raw.reschedules.length;
  if (isFollowUpQuestion && !raw.reply && raw.clarifications.length === 0 && actionCount > 0) {
    try {
      const second = await invokeWithValidation({
        ...invokeOpts,
        // A prompt nudge alone still gets ignored — the retry makes `reply` a required
        // field of the tool schema, so the forced tool call physically must answer.
        tool: {
          ...TOOL,
          inputSchema: {
            ...TOOL.inputSchema,
            required: [...(TOOL.inputSchema.required as string[]), "reply"],
          },
        },
        user:
          `${text}\n\n` +
          `(Correction: you proposed correctly but did not answer the admin's question ` +
          `${JSON.stringify(latest)} — put the answer in the \`reply\` field, keeping the ` +
          `proposal unchanged. Do not fold the answer into assumptions.)`,
      });
      if (second.reply) raw = second;
    } catch {
      // The first attempt was valid — a failed retry never makes the response worse.
    }
  }

  let proposal = repairClashes(raw, upcoming, properties);
  // Spoken text (reply, assumptions) renders as Vera talking; the prompt asks for no
  // markdown and no internal ids, but the guarantee is (as ever) code, not model
  // compliance — a leaked "prop_quays" gets swapped for the property's name.
  const idNames = new Map<string, string>([
    ...properties.map((p) => [p.id, p.name] as const),
    ...leads.map((l) => [l.id, l.name] as const),
  ]);
  const humanize = (text: string) => {
    let out = text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
    for (const [id, name] of idNames) out = out.split(id).join(name);
    return out;
  };
  proposal = {
    ...proposal,
    assumptions: proposal.assumptions.map(humanize),
    ...(proposal.reply ? { reply: humanize(proposal.reply) } : {}),
  };

  // Denormalise whatever existing viewings the proposal touches, so the preview can
  // show the admin exactly what's about to be cancelled or moved (and who accepted).
  const referencedIds = [
    ...new Set([...(proposal.cancelSlotIds ?? []), ...(proposal.reschedules ?? []).map((r) => r.slotId)]),
  ];
  let existingSlots: SlotWithCounts[] | undefined;
  if (referencedIds.length > 0) {
    const rows = await prisma.viewingSlot.findMany({
      where: { id: { in: referencedIds } },
      include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
      orderBy: { startsAt: "asc" },
    });
    existingSlots = rows.map((slot) => ({
      id: slot.id,
      property: { id: slot.property.id, name: slot.property.name, address: slot.property.address },
      startsAt: slot.startsAt.toISOString(),
      durationMins: slot.durationMins,
      maxAttendees: slot.maxAttendees,
      acceptedCount: slot._count.invitations,
    }));
  }

  return { proposal, properties, leads, existingSlots };
}
