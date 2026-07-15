import type { LlmClient, StreamTextRequest, ToolCallRequest, ToolCallResult } from "./llm.js";

// Deterministic demo client (LLM_MODE=mock): lets anyone exercise the full UX with no
// API key. It fakes the *model*, never the fence — its output goes through exactly the
// same Zod validation, audit logging, and human-approval gates as the real thing, which
// is the point of the LlmClient seam. Heuristics are deliberately simple; this is a
// stand-in for a demo, not an NLP engine.

function extractIds(system: string, section: "PROPERTIES" | "LEADS"): { id: string; label: string }[] {
  // The grounding prompt lists entities as "- <id>: <name> ...". The demo client reads
  // them back out, so its output always references real ids and passes validation.
  const lines = system.split("\n");
  const start = lines.findIndex((l) => l.startsWith(section));
  if (start === -1) return [];
  const out: { id: string; label: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^- ([^:]+): (.+)$/.exec(lines[i] ?? "");
    if (!match) break;
    out.push({ id: match[1]!.trim(), label: match[2]!.trim() });
  }
  return out;
}

// Small Levenshtein for did-you-mean: a typo'd name is the most common "unknown person"
// by far, and suggesting is safe because a suggestion is a question, never an action.
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length]![b.length]!;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Honour the day the admin actually named (or answered via a clarification chip);
// Tuesday is only the fallback for requests that never mention a day.
function nextMentionedDay(text: string): string {
  const d = new Date();
  if (/\btomorrow\b/.test(text)) {
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const mentioned = WEEKDAYS.findIndex((day) => text.includes(day));
  const target = mentioned === -1 ? 2 : mentioned;
  const delta = ((target - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function firstNameOf(label: string): string {
  return label.split(" ")[0] ?? "there";
}

// The grounding prompt lists existing viewings as "- <id> | <propertyId>: ..." — read
// them back out so demo cancellations reference real ids and pass validation.
function extractBooked(system: string): { id: string; propertyId: string }[] {
  const lines = system.split("\n");
  const start = lines.findIndex((l) => l.startsWith("ALREADY BOOKED"));
  if (start === -1) return [];
  const out: { id: string; propertyId: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^- (\S+) \| ([^:]+):/.exec(lines[i] ?? "");
    if (!match) break;
    out.push({ id: match[1]!, propertyId: match[2]!.trim() });
  }
  return out;
}

export class DemoLlmClient implements LlmClient {
  async invokeTool(req: ToolCallRequest): Promise<ToolCallResult> {
    const input =
      req.tool.name === "propose_viewing_slots" ? this.proposeSlots(req) : this.draftInvitations(req);
    return { input, raw: JSON.stringify(input) };
  }

  private proposeSlots(req: ToolCallRequest) {
    const text = req.user.toLowerCase();
    const properties = extractIds(req.system, "PROPERTIES");
    const leads = extractIds(req.system, "LEADS");

    // Vague timing → ask, don't guess (mirrors the real prompt's instruction). Offering
    // the weekdays as options means one tap answers the question — and once a day word
    // is present (typed or tapped), this branch no longer fires.
    const mentionsDay = WEEKDAYS.some((day) => text.includes(day)) || /\btomorrow\b|\btoday\b/.test(text);
    if (!mentionsDay && /sometime|whenever|at some point|next week/.test(text)) {
      return {
        slots: [],
        inviteeLeadIds: [],
        clarifications: [
          {
            question: "Which day would you like the viewings?",
            options: ["Monday", "Tuesday", "Wednesday", "Thursday"],
          },
        ],
        assumptions: [],
      };
    }

    // Cancel-by-NL, demo edition: "cancel ... <property>" cancels that property's
    // upcoming viewings (all of them — the live model targets specific ones).
    if (/\bcancel\b/.test(text)) {
      const target = properties.find((p) =>
        text.includes(p.label.split("—")[0]!.trim().toLowerCase().slice(0, 8))
      );
      const booked = extractBooked(req.system).filter((b) => !target || b.propertyId === target.id);
      const targetName = target?.label.split("—")[0]!.trim();
      if (booked.length === 0) {
        return {
          slots: [],
          inviteeLeadIds: [],
          clarifications: [
            { question: `There are no upcoming viewings${targetName ? ` at ${targetName}` : ""} to cancel.` },
          ],
          assumptions: [],
        };
      }
      return {
        slots: [],
        inviteeLeadIds: [],
        clarifications: [],
        cancelSlotIds: booked.map((b) => b.id),
        assumptions: [
          `Demo mode cancels every upcoming viewing${targetName ? ` at ${targetName}` : ""} — the live model can target specific ones.`,
        ],
      };
    }

    // Questions and queries get a spoken answer, not an empty proposal. (Explicit
    // "cancel …" was handled above, so a polite instruction still acts.)
    if (/\b(list|show|delete)\b|\bcan you\b|\bwhat\b|\?\s*$/.test(text)) {
      const booked = extractBooked(req.system);
      const reply =
        booked.length > 0
          ? `There ${booked.length === 1 ? "is 1 upcoming viewing" : `are ${booked.length} upcoming viewings`} booked — the Viewings page has the full list. ` +
            `I can create, cancel or move them from here: try "cancel Tuesday's viewings at 22 Maple Street" or "move the 5pm viewing to 7pm".`
          : `There are no upcoming viewings yet. Describe what you need — property, day, who to invite — and I'll set them up.`;
      return { slots: [], inviteeLeadIds: [], clarifications: [], assumptions: [], reply };
    }

    // Property: first one whose name appears in the text, else the first property.
    const property =
      properties.find((p) => text.includes(p.label.split("—")[0]!.trim().toLowerCase().slice(0, 8))) ??
      properties[0];
    if (!property)
      return {
        slots: [],
        inviteeLeadIds: [],
        clarifications: [{ question: "No properties exist yet." }],
        assumptions: [],
      };

    // Leads: match on ANY name token — first name, surname, or full name — so
    // "invite Emma" works as well as "invite the Johnson lead". (Name tokens only:
    // the label's notes portion is stripped so note words can't false-match.)
    const invitees = leads.filter((l) => {
      const name = l.label.split(" (")[0]!.trim().toLowerCase();
      return name
        .split(/\s+/)
        .some((token) => token.length >= 3 && new RegExp(`\\b${token}\\b`, "i").test(text));
    });

    // Never silently drop an invitee — a missing person is the worst failure mode:
    // nobody notices until the viewing happens without them. Take the invite clause up
    // to the first boundary word (times/places start there), then treat EVERY remaining
    // token — any capitalisation, people type lowercase on phones — as a person-claim
    // that must resolve. Unresolved claims become questions, never omissions.
    const inviteClause = /(?:invite|invitees?|send (?:it |this )?to)\s+(.+)$/i.exec(req.user)?.[1] ?? "";
    const BOUNDARIES = new Set(["on", "at", "for", "next", "this", "in", "by", "from", "tomorrow", "today"]);
    const NOT_NAMES = new Set([
      "the", "and", "a", "an", "to", "lead", "leads", "team", "please", "everyone",
      "all", "both", "them", "guys", "folks",
    ]);
    const rosterTokens = new Set(
      leads.flatMap((l) => l.label.split(" (")[0]!.toLowerCase().split(/\s+/))
    );
    const unmatchedNames: string[] = [];
    for (const raw of inviteClause.split(/[,\s]+/)) {
      const word = raw.replace(/[^A-Za-z'-]/g, "");
      const lower = word.toLowerCase();
      if (!word) continue;
      if (BOUNDARIES.has(lower)) break; // times/places from here on
      if (NOT_NAMES.has(lower) || rosterTokens.has(lower) || word.length < 2) continue;
      unmatchedNames.push(word);
    }

    if (unmatchedNames.length > 0 || (invitees.length === 0 && inviteClause)) {
      // A person reference is a claim to resolve, never a string to match:
      // near-miss → "did you mean…?", truly unknown → say so by name.
      const suggestions: string[] = [];
      const corrections: { from: string; to: string }[] = [];
      const unknown: string[] = [];
      for (const name of unmatchedNames) {
        let best: { fullName: string; distance: number } | null = null;
        for (const lead of leads) {
          const fullName = lead.label.split(" (")[0]!.trim();
          for (const token of fullName.toLowerCase().split(/\s+/)) {
            const distance = editDistance(name.toLowerCase(), token);
            if (!best || distance < best.distance) best = { fullName, distance };
          }
        }
        if (best && best.distance <= 2 && best.distance < name.length) {
          suggestions.push(`Did you mean ${best.fullName} (for "${name}")?`);
          corrections.push({ from: name, to: best.fullName });
        } else {
          unknown.push(`"${name}"`);
        }
      }
      const clarifications: { question: string; options?: string[]; multiple?: boolean }[] =
        suggestions.map((question) => ({ question }));
      if (unknown.length > 0) {
        clarifications.push({
          question: `I couldn't find ${unknown.join(" or ")} in your leads — they may need to be added as a lead first.`,
        });
      }
      if (clarifications.length === 0) {
        // Options only when there's a real choice — the validation fence requires 2–6.
        const names = leads.slice(0, 6).map((l) => l.label.split(" (")[0]!.trim());
        clarifications.push({
          question: "Who should I invite?",
          ...(names.length >= 2 ? { options: names, multiple: true } : {}),
        });
      }
      return {
        slots: [],
        inviteeLeadIds: [],
        clarifications: clarifications.slice(0, 5),
        corrections: corrections.slice(0, 5),
        assumptions: [],
      };
    }

    const countMatch = /(\d+)\s*(?:x\s*)?(?:viewing|slot)/.exec(text)?.[1];
    const durationMatch = /(\d+)[- ]?min/.exec(text)?.[1];
    const maxMatch = /max\s*(\d+)/.exec(text)?.[1];
    const count = Math.min(parseInt(countMatch ?? "3", 10) || 3, 6);
    const duration = parseInt(durationMatch ?? "30", 10) || 30;
    const maxAttendees = parseInt(maxMatch ?? "5", 10) || 5;
    const timeWord = /morning/.test(text) ? "morning" : /evening/.test(text) ? "evening" : /afternoon/.test(text) ? "afternoon" : null;
    const startHour = timeWord === "morning" ? 9 : timeWord === "evening" ? 17 : 14;

    // Every judgement call is surfaced, mirroring the real prompt's `assumptions` rule —
    // spoken first-person sentences, because they render as the AI's own words in the
    // preview bubble.
    const startLabel = startHour === 9 ? "9am" : startHour === 17 ? "5pm" : "2pm";
    const assumptions: string[] = [];
    if (timeWord) assumptions.push(`I read "${timeWord}" as slots starting at ${startLabel}.`);
    else assumptions.push(`You didn't mention a time of day, so I started at ${startLabel}.`);
    if (!countMatch) assumptions.push("You didn't say how many, so I planned 3 viewings.");
    if (!durationMatch) assumptions.push("I used the default 30-minute duration.");
    if (!maxMatch) assumptions.push("I capped each at 5 people, the default.");
    if (count > 1) assumptions.push("They're scheduled back-to-back.");

    const date = nextMentionedDay(text);
    const slots = Array.from({ length: count }, (_, i) => {
      const minutes = startHour * 60 + i * duration;
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      return { propertyId: property.id, date, startTime: `${hh}:${mm}`, durationMins: duration, maxAttendees };
    });

    const window =
      timeWord === "morning"
        ? { earliest: "09:00", latest: "12:00" }
        : timeWord === "evening"
          ? { earliest: "17:00", latest: "20:00" }
          : timeWord === "afternoon"
            ? { earliest: "13:00", latest: "17:00" }
            : { earliest: "13:00", latest: "19:00" };

    return { slots, inviteeLeadIds: invitees.map((l) => l.id), clarifications: [], assumptions, window };
  }

  private draftInvitations(req: ToolCallRequest) {
    const leads = req.user
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => /^- ([^:]+): ([^—\n]+)(?:— notes: (.*))?$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m));
    const property = /PROPERTY: (.*)/.exec(req.user)?.[1] ?? "the property";
    const when = /VIEWING: ([^(]*)/.exec(req.user)?.[1]?.trim() ?? "the arranged time";
    return {
      drafts: leads.map((m) => ({
        leadId: m[1]!.trim(),
        message: demoMessage(firstNameOf(m[2]!.trim()), property, when, m[3]?.trim()),
      })),
    };
  }

  async streamText(req: StreamTextRequest, onDelta: (text: string) => void): Promise<string> {
    const lead = /LEAD: ([^—\n]+)(?:— notes: (.*))?/.exec(req.user);
    const property = /PROPERTY: (.*)/.exec(req.user)?.[1] ?? "the property";
    const when = /VIEWING: ([^(]*)/.exec(req.user)?.[1]?.trim() ?? "the arranged time";
    const message = demoMessage(firstNameOf(lead?.[1]?.trim() ?? "there"), property, when, lead?.[2]?.trim());

    // Word-by-word with a small delay so the streaming UI is actually visible.
    for (const word of message.split(" ")) {
      onDelta(word + " ");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return message;
  }
}

function demoMessage(firstName: string, property: string, when: string, notes?: string): string {
  // Property lines arrive as "Name — Address"; the message uses the name only, so the
  // address isn't repeated mid-sentence (the invitee page shows it separately).
  const propertyName = property.split(" — ")[0]!.trim();
  const personal = notes ? ` From your notes — ${notes.replace(/\.$/, "")} — we think it could be a great fit.` : "";
  return (
    `Hi ${firstName} — we'd love to show you ${propertyName} on ${when}.${personal} ` +
    `Spaces on this viewing are limited, so please confirm if you can make it and we'll hold your spot. ` +
    `[Demo mode: this message was generated by a canned template, not a live model.]`
  );
}
