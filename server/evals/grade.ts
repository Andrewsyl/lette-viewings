import type { SlotProposal } from "@lette/shared";

// Atomic, deterministic checks. Each case is a list of these rather than one blended
// score, so a failure says WHICH promise broke ("asked instead of proposing", "leaked an
// id") and the same check reads the same way across runs. No LLM judge: every behaviour
// graded here is something the code can see in the structured output.

export interface Check {
  name: string;
  pass: boolean;
  /** What was actually seen, for failures. */
  detail?: string;
}

const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, ...(pass ? {} : { detail }) });
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
const fmt = (v: unknown) => JSON.stringify(v);

function actionCount(p: SlotProposal) {
  return (
    p.slots.length + (p.cancelSlotIds?.length ?? 0) + (p.reschedules?.length ?? 0) + (p.addInvitees?.length ?? 0)
  );
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface ProposeExpectation {
  propertyId: string;
  date: string;
  invitees: string[];
  count?: number;
  /** Exact start of the earliest slot — only when the admin named a clock time. */
  firstStart?: string;
  /** Every slot must start and end inside this range (a part of day). */
  within?: { earliest: string; latest: string };
  /** Existing viewings the new slots must not overlap. */
  avoid?: { date: string; startTime: string; durationMins: number }[];
}

/** The admin gave everything — a preview should come back, not a question. */
export function proposes(p: SlotProposal, e: ProposeExpectation): Check[] {
  const slots = p.slots;
  const checks = [
    check("proposes (no question)", slots.length > 0 && p.clarifications.length === 0,
      `slots=${slots.length}, asked=${fmt(p.clarifications.map((c) => c.question))}`),
    check("right property", slots.length > 0 && slots.every((s) => s.propertyId === e.propertyId),
      fmt(slots.map((s) => s.propertyId))),
    check("right day", slots.length > 0 && slots.every((s) => s.date === e.date),
      `expected ${e.date}, got ${fmt(slots.map((s) => s.date))}`),
    check("right invitees", sameSet(p.inviteeLeadIds, e.invitees),
      `expected ${fmt(e.invitees)}, got ${fmt(p.inviteeLeadIds)}`),
    check("no unrequested cancels/moves",
      (p.cancelSlotIds?.length ?? 0) + (p.reschedules?.length ?? 0) === 0,
      fmt({ cancel: p.cancelSlotIds, reschedules: p.reschedules })),
  ];
  if (e.count !== undefined) {
    checks.push(check("right number of viewings", slots.length === e.count, `expected ${e.count}, got ${slots.length}`));
  }
  if (e.firstStart !== undefined) {
    const first = [...slots].sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
    checks.push(check("starts at the named time", first?.startTime === e.firstStart,
      `expected ${e.firstStart}, got ${first?.startTime}`));
  }
  if (e.within) {
    const lo = minutes(e.within.earliest);
    const hi = minutes(e.within.latest);
    checks.push(check("inside the stated part of day",
      slots.every((s) => minutes(s.startTime) >= lo && minutes(s.startTime) + s.durationMins <= hi),
      fmt(slots.map((s) => `${s.startTime}+${s.durationMins}`))));
  }
  if (e.avoid) {
    const clash = slots.some((s) =>
      e.avoid!.some((b) =>
        b.date === s.date &&
        minutes(s.startTime) < minutes(b.startTime) + b.durationMins &&
        minutes(b.startTime) < minutes(s.startTime) + s.durationMins
      )
    );
    checks.push(check("no double-booking", !clash, fmt(slots.map((s) => s.startTime))));
  }
  return checks;
}

export interface AskExpectation {
  /** The question should be about this (e.g. /propert/i). */
  about?: RegExp;
  /** One-tap options that must be offered (case-insensitive substring match). */
  optionsInclude?: string[];
  multiple?: boolean;
}

/** Something blocking was missing or wrong — ONE question, nothing proposed or touched. */
export function asks(p: SlotProposal, e: AskExpectation = {}): Check[] {
  const q = p.clarifications[0];
  const checks = [
    check("asks one question", p.clarifications.length === 1, `asked ${p.clarifications.length}`),
    check("proposes/changes nothing yet", actionCount(p) === 0,
      fmt({ slots: p.slots.length, cancel: p.cancelSlotIds, reschedules: p.reschedules, add: p.addInvitees })),
  ];
  if (e.about) {
    checks.push(check(`question is about ${e.about.source}`, !!q && e.about.test(q.question), q?.question));
  }
  if (e.optionsInclude) {
    const opts = (q?.options ?? []).map((o) => o.toLowerCase());
    const missing = e.optionsInclude.filter((want) => !opts.some((o) => o.includes(want.toLowerCase())));
    checks.push(check("offers the right one-tap options", missing.length === 0,
      `missing ${fmt(missing)} in ${fmt(q?.options)}`));
  }
  if (e.multiple !== undefined) {
    checks.push(check(`multiple=${e.multiple}`, (q?.multiple ?? false) === e.multiple, fmt(q?.multiple)));
  }
  return checks;
}

/** A question or non-instruction — answered in words, nothing proposed. */
export function replies(p: SlotProposal, mentions?: RegExp): Check[] {
  const checks = [
    check("answers in reply", !!p.reply?.trim(), "no reply"),
    check("proposes/changes nothing", actionCount(p) === 0 && p.clarifications.length === 0,
      fmt({ actions: actionCount(p), asked: p.clarifications.map((c) => c.question) })),
  ];
  if (mentions) checks.push(check(`reply mentions ${mentions.source}`, mentions.test(p.reply ?? ""), p.reply));
  return checks;
}

export function cancels(p: SlotProposal, ids: string[]): Check[] {
  return [
    check("cancels exactly what was asked", sameSet(p.cancelSlotIds ?? [], ids),
      `expected ${fmt(ids)}, got ${fmt(p.cancelSlotIds)}`),
    check("no question", p.clarifications.length === 0, fmt(p.clarifications.map((c) => c.question))),
    check("no new viewings or moves", p.slots.length === 0 && (p.reschedules?.length ?? 0) === 0,
      fmt({ slots: p.slots.length, reschedules: p.reschedules })),
  ];
}

export function reschedules(p: SlotProposal, expected: { slotId: string; date: string; startTime: string }[]): Check[] {
  const got = (p.reschedules ?? []).map((r) => `${r.slotId}@${r.date}T${r.startTime}`);
  const want = expected.map((r) => `${r.slotId}@${r.date}T${r.startTime}`);
  return [
    check("moves exactly what was asked, to the right time", sameSet(got, want), `expected ${fmt(want)}, got ${fmt(got)}`),
    check("no question", p.clarifications.length === 0, fmt(p.clarifications.map((c) => c.question))),
    check("no new viewings or cancels", p.slots.length === 0 && (p.cancelSlotIds?.length ?? 0) === 0,
      fmt({ slots: p.slots.length, cancel: p.cancelSlotIds })),
  ];
}

export function addsInvitees(p: SlotProposal, slotId: string, leadIds: string[]): Check[] {
  const adds = p.addInvitees ?? [];
  return [
    check("invites to the existing viewing", adds.length === 1 && adds[0]!.slotId === slotId,
      fmt(adds.map((a) => a.slotId))),
    check("invites the right people", adds.length === 1 && sameSet(adds[0]!.leadIds, leadIds),
      fmt(adds.map((a) => a.leadIds))),
    check("no new viewings, cancels or moves",
      p.slots.length === 0 && (p.cancelSlotIds?.length ?? 0) === 0 && (p.reschedules?.length ?? 0) === 0,
      fmt({ slots: p.slots.length, cancel: p.cancelSlotIds, reschedules: p.reschedules })),
  ];
}

/** Passes if ANY of the alternative readings passes in full — for cases where the
 *  prompt allows two right answers (e.g. a typo the model may fix or ask about). */
export function oneOf(name: string, ...alternatives: Check[][]): Check[] {
  const best = alternatives.find((alt) => alt.every((c) => c.pass));
  if (best) return [check(name, true)];
  const fails = alternatives.map((alt) => alt.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail ?? ""}`).join("; "));
  return [check(name, false, fails.map((f, i) => `option ${i + 1} → ${f}`).join(" | "))];
}

/** Applied to every parse case: Vera's spoken text never shows internal ids or markdown. */
export function spokenTextIsClean(p: SlotProposal): Check[] {
  const spoken = [
    p.reply ?? "",
    p.normalizedRequest ?? "",
    ...p.assumptions,
    ...p.clarifications.flatMap((c) => [c.question, ...(c.options ?? [])]),
  ].join("\n");
  const ids = spoken.match(/\b(prop|lead|slot|evt)_[a-z0-9_]+\b/gi) ?? [];
  return [
    check("no internal ids in what Vera says", ids.length === 0, fmt(ids)),
    check("no markdown in what Vera says", !/\*\*|^#+\s|^\s*[-*]\s/m.test(spoken), spoken.slice(0, 200)),
  ];
}

// ---------- Drafts ----------

export interface DraftExpectation {
  firstName: string;
  propertyName: string;
  /** e.g. "Thursday" */
  weekday: string;
  /** HH:MM 24h — matched in any voice the model uses (14:00, 2pm, 2:00 pm, 2 o'clock). */
  time: string;
  /** Something from the lead's notes the message should pick up, e.g. /parking/i. */
  personal?: RegExp;
}

function timeVoices(hhmm: string): RegExp {
  const h = Number(hhmm.slice(0, 2));
  const mm = hhmm.slice(3, 5);
  const h12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "a\\.?m" : "p\\.?m";
  const minutePart = mm === "00" ? `(?:[:.]00)?` : `[:.]${mm}`;
  return new RegExp(`(?<!\\d)(?:${hhmm}|${h}[:.]${mm}|${h12}${minutePart}\\s?${ampm}|${h12}${mm === "00" ? "" : `[:.]${mm}`}\\s?o'?clock)`, "i");
}

export function gradeDraft(message: string, e: DraftExpectation): Check[] {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const checks = [
    check("greets by first name", new RegExp(`\\b${e.firstName}\\b`).test(message.slice(0, 80)), message.slice(0, 80)),
    check("names the property", message.includes(e.propertyName), "property name missing"),
    check("gives the day", new RegExp(`\\b${e.weekday}\\b`, "i").test(message), "weekday missing"),
    check("gives the time", timeVoices(e.time).test(message), `no mention of ${e.time}`),
    check("says spaces are limited / asks to confirm", /limited|confirm/i.test(message), "no limited/confirm"),
    check("60–120 words", words >= 60 && words <= 120, `${words} words`),
    check("no placeholders", !/\[[^\]]*\]|\{[^}]*\}|<[^>]*>/.test(message), "placeholder found"),
    check("no subject line", !/^subject:/im.test(message), "subject line found"),
  ];
  if (e.personal) {
    checks.push(check(`uses the lead's notes (${e.personal.source})`, e.personal.test(message), "not mentioned"));
  }
  return checks;
}
