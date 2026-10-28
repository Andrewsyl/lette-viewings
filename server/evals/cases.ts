import type { SlotProposal } from "@lette/shared";
import { addDays, nextWeekday, type BookedFixture } from "./fixtures.js";
import {
  addsInvitees, asks, cancels, oneOf, proposes, replies, reschedules, type Check, type DraftExpectation,
} from "./grade.js";

// The case set. Each case is a request an admin could really type, plus what the prompt
// rules in parseSlots.ts say must come back. Dates are relative ("Thursday" = the first
// Thursday in the prompt's CALENDAR), so the set runs any day of the week without edits.
// When a rule in the prompt changes, the case that encodes it changes in the same commit.

export interface Days {
  now: Date;
  monday: string; tuesday: string; wednesday: string; thursday: string;
  friday: string; saturday: string; sunday: string;
}

export function daysFrom(now: Date): Days {
  const d = (w: string) => nextWeekday(now, w);
  return {
    now,
    monday: d("monday"), tuesday: d("tuesday"), wednesday: d("wednesday"), thursday: d("thursday"),
    friday: d("friday"), saturday: d("saturday"), sunday: d("sunday"),
  };
}

export interface ParseCase {
  id: string;
  /** First tag is the group the summary reports by. */
  tags: string[];
  booked?: (d: Days) => BookedFixture[];
  text: (d: Days) => string;
  grade: (p: SlotProposal, d: Days) => Check[];
}

const SYC = "prop_sycamore";
const RIV = "prop_quays";
const BOT = "prop_phibs";

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

export const PARSE_CASES: ParseCase[] = [
  // ---- Everything given: a preview, no questions ----
  {
    id: "explicit-three-from-2pm",
    tags: ["propose"],
    text: () => "Book three 30-minute viewings at 17 Sycamore Lane on Thursday from 2pm, invite Sarah Kavanagh and Priya Sharma",
    grade: (p, d) => proposes(p, { propertyId: SYC, date: d.thursday, count: 3, firstStart: "14:00", invitees: ["lead_kavanagh", "lead_sharma"] }),
  },
  {
    id: "afternoon-range",
    tags: ["propose"],
    text: () => "Two viewings at 9 Botanic View on Friday afternoon for Ada Okafor",
    grade: (p, d) => proposes(p, { propertyId: BOT, date: d.friday, count: 2, within: { earliest: "13:00", latest: "17:00" }, invitees: ["lead_okafor"] }),
  },
  {
    id: "defaults-applied-not-asked",
    tags: ["propose"],
    text: () => "A viewing at Riverpoint Apartments on Wednesday at 10am, invite Tomasz Nowak",
    grade: (p, d) => [
      ...proposes(p, { propertyId: RIV, date: d.wednesday, count: 1, firstStart: "10:00", invitees: ["lead_nowak"] }),
      { name: "default 30 min / max 5", pass: p.slots.every((s) => s.durationMins === 30 && s.maxAttendees === 5), detail: JSON.stringify(p.slots) },
    ],
  },
  {
    id: "next-weekday-reads-calendar",
    tags: ["propose", "dates"],
    text: () => "Viewing at Riverpoint Apartments next Tuesday at 6pm for Priya Sharma",
    grade: (p, d) => proposes(p, { propertyId: RIV, date: d.tuesday, count: 1, firstStart: "18:00", invitees: ["lead_sharma"] }),
  },
  {
    id: "typo-single-match",
    tags: ["propose", "names"],
    text: () => "Viewing at 17 Sycamore Lane on Thursday at 3pm, invite Pryia",
    // The prompt allows either: use the one lead it clearly matches, or ask "Did you mean…?".
    grade: (p, d) => oneOf("fixes or asks about the typo",
      proposes(p, { propertyId: SYC, date: d.thursday, firstStart: "15:00", invitees: ["lead_sharma"] }),
      asks(p, { about: /Priya/ })),
  },
  {
    id: "range-clash-repaired",
    tags: ["propose", "clashes"],
    booked: (d) => [{ id: "slot_bot_fri", propertyId: BOT, date: d.friday, startTime: "14:00", durationMins: 60 }],
    text: () => "Three viewings at 9 Botanic View on Friday afternoon for Ada Okafor",
    grade: (p, d) => proposes(p, {
      propertyId: BOT, date: d.friday, count: 3, invitees: ["lead_okafor"],
      within: { earliest: "13:00", latest: "17:00" },
      avoid: [{ date: d.friday, startTime: "14:00", durationMins: 60 }],
    }),
  },

  // ---- Something blocking is missing: one question, nothing proposed ----
  {
    id: "no-property",
    tags: ["ask"],
    text: () => "Give me a few bookings on Thursday at 2pm for Conor Murphy",
    grade: (p) => asks(p, { about: /propert/i, optionsInclude: ["17 Sycamore Lane", "Riverpoint Apartments", "9 Botanic View"] }),
  },
  {
    id: "no-day",
    tags: ["ask"],
    text: () => "Book a viewing at 9 Botanic View at 11am for Emma Walsh",
    grade: (p) => asks(p, { about: /day|date|when/i }),
  },
  {
    id: "no-time",
    tags: ["ask"],
    text: () => "Book a viewing at 9 Botanic View on Friday for Emma Walsh",
    grade: (p) => asks(p, { about: /time/i }),
  },
  {
    id: "no-invitees",
    tags: ["ask"],
    text: () => "Book two viewings at Riverpoint Apartments on Thursday at 2pm",
    grade: (p) => asks(p, { about: /invite|who/i, optionsInclude: ["Sarah Kavanagh", "Tomasz Nowak"], multiple: true }),
  },
  {
    id: "vague-next-week",
    tags: ["ask", "dates"],
    text: () => "Set up viewings at 17 Sycamore Lane sometime next week in the afternoon for Ada Okafor",
    grade: (p) => asks(p, { about: /day|date|when/i }),
  },
  {
    id: "unknown-person",
    tags: ["ask", "names"],
    text: () => "Book a viewing at 9 Botanic View on Friday at 11am for Bob Smith",
    grade: (p) => asks(p, { about: /Bob/ }),
  },
  {
    id: "self-contradicting-date",
    tags: ["ask", "dates"],
    text: (d) => `Viewing at Riverpoint Apartments on Saturday the ${ordinal(Number(addDays(d.saturday, 2).slice(8, 10)))} at 11am for Conor Murphy`,
    grade: (p) => asks(p, { about: /saturday|monday/i }),
  },
  {
    id: "named-time-clash",
    tags: ["ask", "clashes"],
    booked: (d) => [{ id: "slot_riv_thu", propertyId: RIV, date: d.thursday, startTime: "14:00" }],
    text: () => "Viewing at Riverpoint Apartments on Thursday at 2pm for Conor Murphy",
    grade: (p) => asks(p, { about: /book/i, optionsInclude: ["2:30pm"] }),
  },
  {
    id: "move-to-other-property",
    tags: ["ask", "changes"],
    booked: (d) => [{ id: "slot_syc_wed", propertyId: SYC, date: d.wednesday, startTime: "14:00", inviteeLeadIds: ["lead_murphy"] }],
    text: () => "Move the Wednesday viewing at 17 Sycamore Lane to Riverpoint Apartments",
    grade: (p) => asks(p, { about: /Riverpoint/i }),
  },
  {
    id: "ambiguous-cancel",
    tags: ["ask", "changes"],
    booked: (d) => [
      { id: "slot_syc_tue", propertyId: SYC, date: d.tuesday, startTime: "14:00" },
      { id: "slot_syc_thu", propertyId: SYC, date: d.thursday, startTime: "11:00" },
    ],
    text: () => "Cancel the Sycamore Lane viewing",
    grade: (p) => asks(p),
  },

  // ---- Questions: answered in words, nothing proposed ----
  {
    id: "whats-booked",
    tags: ["reply"],
    booked: (d) => [{ id: "slot_bot_thu", propertyId: BOT, date: d.thursday, startTime: "14:00" }],
    text: () => "What's booked on Thursday?",
    grade: (p) => replies(p, /Botanic/i),
  },
  {
    id: "capability-question",
    tags: ["reply"],
    booked: (d) => [{ id: "slot_syc_tue", propertyId: SYC, date: d.tuesday, startTime: "14:00" }],
    text: () => "Can you delete viewings?",
    grade: (p) => replies(p),
  },
  {
    id: "availability-question",
    tags: ["reply", "clashes"],
    booked: (d) => [{ id: "slot_riv_tue", propertyId: RIV, date: d.tuesday, startTime: "13:00", durationMins: 60 }],
    text: () => "Is anything free at Riverpoint Apartments earlier than 1pm on Tuesday?",
    // Never picks a time itself: an answer (or a question back), but no slot.
    grade: (p) => [{ name: "doesn't book an unnamed time", pass: p.slots.length === 0, detail: JSON.stringify(p.slots) },
      { name: "says something", pass: !!p.reply?.trim() || p.clarifications.length > 0, detail: "silent" }],
  },

  // ---- Changes to existing viewings ----
  {
    id: "cancel-by-day-and-property",
    tags: ["changes"],
    booked: (d) => [
      { id: "slot_syc_tue_a", propertyId: SYC, date: d.tuesday, startTime: "14:00" },
      { id: "slot_syc_tue_b", propertyId: SYC, date: d.tuesday, startTime: "15:00" },
      { id: "slot_riv_tue", propertyId: RIV, date: d.tuesday, startTime: "10:00" },
    ],
    text: () => "Cancel Tuesday's viewings at 17 Sycamore Lane",
    grade: (p) => cancels(p, ["slot_syc_tue_a", "slot_syc_tue_b"]),
  },
  {
    id: "polite-cancel-is-an-instruction",
    tags: ["changes"],
    booked: (d) => [
      { id: "slot_syc_tue_a", propertyId: SYC, date: d.tuesday, startTime: "14:00" },
      { id: "slot_riv_tue", propertyId: RIV, date: d.tuesday, startTime: "10:00" },
    ],
    text: () => "Can you cancel Tuesday's viewing at 17 Sycamore Lane?",
    grade: (p) => cancels(p, ["slot_syc_tue_a"]),
  },
  {
    id: "reschedule",
    tags: ["changes"],
    booked: (d) => [{ id: "slot_syc_wed", propertyId: SYC, date: d.wednesday, startTime: "14:00", inviteeLeadIds: ["lead_murphy"] }],
    text: () => "Move the Wednesday viewing at 17 Sycamore Lane to Thursday at 4pm",
    grade: (p, d) => reschedules(p, [{ slotId: "slot_syc_wed", date: d.thursday, startTime: "16:00" }]),
  },
  {
    id: "add-invitees-to-existing",
    tags: ["changes"],
    booked: (d) => [{ id: "slot_bot_thu", propertyId: BOT, date: d.thursday, startTime: "14:00", inviteeLeadIds: ["lead_okafor"] }],
    text: () => "Add Tomasz Nowak to Thursday's viewing at 9 Botanic View",
    grade: (p) => addsInvitees(p, "slot_bot_thu", ["lead_nowak"]),
  },

  // ---- Multi-turn: answers appended the way the admin page appends them ----
  {
    id: "answer-folds-in",
    tags: ["multi-turn"],
    text: () => 'Book a viewing at 9 Botanic View on Friday at 3pm\n\nClarification — "Who should be invited to the viewing?": Emma Walsh, Conor Murphy',
    grade: (p, d) => proposes(p, { propertyId: BOT, date: d.friday, count: 1, firstStart: "15:00", invitees: ["lead_walsh", "lead_murphy"] }),
  },
  {
    id: "follow-up-question-keeps-plan",
    tags: ["multi-turn"],
    text: () => "Book viewings at 17 Sycamore Lane on Thursday at 2pm and 3pm for Conor Murphy\n\nwait, will Conor get two invites?",
    grade: (p, d) => [
      ...proposes(p, { propertyId: SYC, date: d.thursday, count: 2, firstStart: "14:00", invitees: ["lead_murphy"] }),
      { name: "answers the question too", pass: !!p.reply?.trim(), detail: "no reply" },
    ],
  },
];

// ---------- Drafts ----------

export interface DraftCase {
  id: string;
  tags: string[];
  slot: (d: Days) => BookedFixture;
  leads: { leadId: string; expect: Omit<DraftExpectation, "weekday" | "time" | "propertyName"> }[];
}

export const DRAFT_CASES: DraftCase[] = [
  {
    id: "sycamore-thursday-2pm",
    tags: ["draft"],
    slot: (d) => ({ id: "slot_draft_syc", propertyId: SYC, date: d.thursday, startTime: "14:00" }),
    leads: [
      { leadId: "lead_kavanagh", expect: { firstName: "Sarah", personal: /parking/i } },
      { leadId: "lead_murphy", expect: { firstName: "Conor" } },
    ],
  },
  {
    id: "botanic-friday-5-30pm",
    tags: ["draft"],
    slot: (d) => ({ id: "slot_draft_bot", propertyId: BOT, date: d.friday, startTime: "17:30" }),
    leads: [
      { leadId: "lead_walsh", expect: { firstName: "Emma", personal: /bike|cycl/i } },
      { leadId: "lead_sharma", expect: { firstName: "Priya", personal: /dog|pet/i } },
    ],
  },
  {
    id: "riverpoint-wednesday-9am",
    tags: ["draft"],
    slot: (d) => ({ id: "slot_draft_riv", propertyId: RIV, date: d.wednesday, startTime: "09:00" }),
    leads: [
      { leadId: "lead_nowak", expect: { firstName: "Tomasz", personal: /brother/i } },
      { leadId: "lead_okafor", expect: { firstName: "Ada", personal: /office|work from home/i } },
    ],
  },
];
