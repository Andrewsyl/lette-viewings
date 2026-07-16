import { describe, it, expect, beforeEach } from "vitest";
import { parseSlotRequest } from "../src/lib/parseSlots.js";
import { LlmOutputError } from "../src/lib/errors.js";
import { prisma } from "../src/lib/db.js";
import { MockLlm, resetDb, seedBasics, validProposal, futureDate } from "./helpers.js";

// The graded question: what happens when the LLM returns garbage?
// Every test here feeds the pipeline a canned model output — no API key involved.

describe("parseSlotRequest", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
  });

  it("accepts a valid proposal and logs the call", async () => {
    const llm = new MockLlm([validProposal()]);
    const result = await parseSlotRequest("three slots for Sycamore Lane at 2pm", llm);

    expect(result.proposal.slots).toHaveLength(2);
    expect(result.proposal.inviteeLeadIds).toEqual(["lead_kavanagh", "lead_sharma"]);
    expect(llm.requests).toHaveLength(1);

    const log = await prisma.llmCallLog.findFirstOrThrow();
    expect(log.kind).toBe("parse_slots");
    expect(log.parsedOk).toBe(true);
  });

  it("repairs once when the first output is garbage, and succeeds", async () => {
    const llm = new MockLlm([{ nonsense: true }, validProposal()]);
    const result = await parseSlotRequest("slots at 2pm please", llm);

    expect(result.proposal.slots).toHaveLength(2);
    expect(llm.requests).toHaveLength(2);
    // The repair prompt must carry the validation errors back to the model.
    expect(llm.requests[1]!.user).toContain("failed validation");
  });

  it("throws a friendly 422 error when output is garbage twice", async () => {
    const llm = new MockLlm([{ nonsense: true }, "not even an object"]);
    await expect(parseSlotRequest("slots please", llm)).rejects.toBeInstanceOf(LlmOutputError);

    const log = await prisma.llmCallLog.findFirstOrThrow();
    expect(log.parsedOk).toBe(false);
    expect(log.error).toBeTruthy();
  });

  it("rejects hallucinated lead ids", async () => {
    const bad = { ...validProposal(), inviteeLeadIds: ["lead_invented"] };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("invite Mr Invented", llm)).rejects.toBeInstanceOf(LlmOutputError);
    expect(llm.requests[1]!.user).toContain("not in the provided lead list");
  });

  it("rejects hallucinated property ids", async () => {
    const bad = {
      ...validProposal(),
      slots: [{ propertyId: "prop_invented", date: futureDate(), startTime: "10:00", durationMins: 30, maxAttendees: 5 }],
    };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("slots at Invented House", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("rejects slots in the past", async () => {
    const bad = {
      ...validProposal(),
      slots: [{ propertyId: "prop_sycamore", date: "2020-01-01", startTime: "10:00", durationMins: 30, maxAttendees: 5 }],
    };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("slots for 2020", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("rejects out-of-bounds duration and capacity", async () => {
    const bad = {
      ...validProposal(),
      slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "10:00", durationMins: 0, maxAttendees: 5000 }],
    };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("a strange slot", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("passes ambiguity through as clarifications, not guesses", async () => {
    const ambiguous = {
      slots: [],
      inviteeLeadIds: [],
      clarifications: [
        {
          question: "Which day next week would you like the viewings?",
          options: ["Monday", "Tuesday", "Wednesday"],
        },
      ],
    };
    const llm = new MockLlm([ambiguous]);
    const result = await parseSlotRequest("some viewings next week sometime", llm);

    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications).toHaveLength(1);
    expect(result.proposal.clarifications[0]!.options).toEqual(["Monday", "Tuesday", "Wednesday"]);
  });

  it("passes the model's assumptions through so the admin can check its reading", async () => {
    const withAssumptions = {
      ...validProposal(),
      assumptions: ['Read "afternoon" as slots starting 14:00.', "Used the default max of 5 attendees."],
    };
    const llm = new MockLlm([withAssumptions]);
    const result = await parseSlotRequest("slots next Tuesday afternoon", llm);

    expect(result.proposal.assumptions).toHaveLength(2);
  });

  it("rejects malformed clarifications (bare strings) via the repair path", async () => {
    const bad = { ...validProposal(), slots: [], clarifications: ["not an object"] };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("something vague", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("grounds already-booked viewings in the prompt so the model can flag clashes", async () => {
    await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const llm = new MockLlm([validProposal()]);
    await parseSlotRequest("more slots at Sycamore Lane", llm);

    const system = llm.requests[0]!.system;
    expect(system).toContain("ALREADY BOOKED");
    expect(system).toContain("prop_sycamore");
  });

  it("retries once when a follow-up question got no reply, and takes the answered attempt", async () => {
    // The model folds the answer into assumptions half the time; the retry makes the
    // spoken answer a guarantee, not a coin flip.
    const silent = validProposal();
    const answered = { ...validProposal(), reply: "Yes — each lead gets one invitation per viewing." };
    const llm = new MockLlm([silent, answered]);
    const result = await parseSlotRequest(
      "two viewings at Sycamore Lane on Tuesday, invite Kavanagh\n\nwait, will this send 2 invites to the same person?",
      llm
    );
    expect(llm.requests).toHaveLength(2);
    // The retry quotes the unanswered question and makes `reply` schema-required —
    // the forced tool call physically must answer.
    expect(llm.requests[1]!.user).toContain('"wait, will this send 2 invites to the same person?"');
    expect((llm.requests[1]!.tool.inputSchema.required as string[])).toContain("reply");
    expect(result.proposal.reply).toContain("one invitation per viewing");
  });

  it("clears slots when the model returns a clarification alongside them (no plan behind a question)", async () => {
    // The model sometimes floats slots — occasionally self-clashing — next to a question.
    // A response with an open question must carry no slots.
    const withBoth = {
      slots: [
        { propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 },
        { propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 },
      ],
      inviteeLeadIds: [],
      window: { earliest: "09:00", latest: "20:00" },
      clarifications: [{ question: "Did you really mean two viewings at the same time?" }],
    };
    const result = await parseSlotRequest("two viewings at Sycamore Lane both at 2pm", new MockLlm([withBoth]));
    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications).toHaveLength(1);
  });

  it("keeps only the first clarification when the model stacks several (one question per turn)", async () => {
    const multi = {
      slots: [],
      inviteeLeadIds: [],
      window: { earliest: "13:00", latest: "19:00" },
      clarifications: [
        { question: "Which day next week?", options: ["Monday 20 July", "Tuesday 21 July"] },
        { question: "What time of day?", options: ["morning", "afternoon", "evening"] },
        { question: "Who should I invite?", options: ["Sarah Kavanagh", "Priya Sharma"], multiple: true },
      ],
    };
    const result = await parseSlotRequest("some viewings next week", new MockLlm([multi]));
    expect(result.proposal.clarifications).toHaveLength(1);
    expect(result.proposal.clarifications[0]!.question).toBe("Which day next week?");
  });

  it("retries a total dead end (no slots, no question, no reply) and forces a spoken reply", async () => {
    // The model shrugs at "what's booked this week?" — an empty proposal with nothing to
    // say. Vera must never render literally nothing; the retry makes `reply` required.
    const empty = { slots: [], inviteeLeadIds: [], clarifications: [], window: { earliest: "09:00", latest: "20:00" } };
    const answered = { ...empty, reply: "Two viewings this week: Friday at 9am and 2pm, both at 17 Sycamore Lane." };
    const llm = new MockLlm([empty, answered]);
    const result = await parseSlotRequest("what's booked this week?", llm);
    expect(llm.requests).toHaveLength(2);
    expect((llm.requests[1]!.tool.inputSchema.required as string[])).toContain("reply");
    expect(result.proposal.reply).toContain("Friday");
  });

  it("does not retry when the question is the whole request, or when a reply came back", async () => {
    // Single-line instruction-questions are instructions (no reply owed)…
    const llm = new MockLlm([validProposal()]);
    await parseSlotRequest("can you set up two viewings at Sycamore Lane on Tuesday?", llm);
    expect(llm.requests).toHaveLength(1);
    // …and an answered follow-up needs no second call.
    const answeredLlm = new MockLlm([{ ...validProposal(), reply: "Yes." }]);
    await parseSlotRequest("two viewings at Sycamore Lane\n\nis this ok?", answeredLlm);
    expect(answeredLlm.requests).toHaveLength(1);
  });

  it("grounds 'today' on the Dublin wall clock, not the UTC date", async () => {
    // 23:30 UTC on 30 June is 00:30 on 1 JULY in Dublin (IST, UTC+1). toISOString()
    // would say June 30 — pairing that with a Dublin weekday hands the model a
    // self-contradictory "today" for an hour every summer night.
    const { dublinDateISO } = await import("../src/lib/parseSlots.js");
    expect(dublinDateISO(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    // Winter (GMT): UTC date and Dublin date agree.
    expect(dublinDateISO(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-15");
  });

  it("refuses to guess a time: clears slots and asks when the request gave none", async () => {
    // The model defaulted a time (2pm) though the admin never gave one. Time is the one
    // detail we don't guess — clear the plan and ask, deterministically.
    const noTimeGiven = validProposal(); // slots at 14:00, but the request below has no time
    const result = await parseSlotRequest(
      "three viewings at Sycamore Lane next Tuesday, invite Kavanagh and Sharma",
      new MockLlm([noTimeGiven])
    );
    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications).toHaveLength(1);
    expect(result.proposal.clarifications[0]!.question).toMatch(/what time/i);
    expect(result.proposal.clarifications[0]!.options).toBeUndefined();
  });

  it("does not ask for a time when the request already gave one", async () => {
    for (const text of [
      "three viewings at Sycamore Lane next Tuesday at 2pm, invite Kavanagh",
      "three viewings at Sycamore Lane next Tuesday afternoon, invite Kavanagh",
      "a viewing at Sycamore Lane next Tuesday at 14:00, invite Kavanagh",
      "a viewing at Sycamore Lane next Tuesday morning, invite Kavanagh",
    ]) {
      const result = await parseSlotRequest(text, new MockLlm([validProposal()]));
      expect(result.proposal.slots.length).toBeGreaterThan(0);
      expect(result.proposal.clarifications).toHaveLength(0);
    }
  });

  it("deduplicates repeated invitee ids ('inviting Conor and Conor' must never render)", async () => {
    const proposal = {
      ...validProposal(),
      inviteeLeadIds: ["lead_kavanagh", "lead_kavanagh", "lead_sharma"],
    };
    const result = await parseSlotRequest("two viewings, invite Kavanagh and Sharma", new MockLlm([proposal]));
    expect(result.proposal.inviteeLeadIds).toEqual(["lead_kavanagh", "lead_sharma"]);
  });

  it("deterministically repairs a proposal that double-books an existing viewing", async () => {
    // Existing booking exactly where validProposal()'s first slot lands (14:00).
    await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T14:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const llm = new MockLlm([validProposal()]);
    const result = await parseSlotRequest("slots at Sycamore Lane at 2pm", llm);

    // Repair-first, window-bounded: the clashing 14:00 slot moves to the earliest free
    // time INSIDE the admin's stated window (13:00), the free 14:30 slot stays put…
    expect(result.proposal.clarifications).toHaveLength(0);
    expect(result.proposal.slots.map((s) => s.startTime)).toEqual(["13:00", "14:30"]);
    // …and the move is spoken in the AI's assumptions for the admin to check.
    expect(result.proposal.assumptions.join(" ")).toContain("so I scheduled around that");
  });

  it("drops model assumptions that narrate a moved slot's original time", async () => {
    await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T14:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    // The model narrates its original plan; the repair then moves 14:00 → 13:00. A
    // preview that says "2pm" while the cards show 1pm is a contradiction — stale
    // time narration must not survive the repair. Time-free assumptions stay.
    const proposal = {
      ...validProposal(),
      assumptions: [
        "I scheduled them back-to-back at 2pm and 2:30pm.",
        "You didn't give a duration, so I went with 30 minutes.",
      ],
    };
    const result = await parseSlotRequest("slots at Sycamore Lane in the afternoon", new MockLlm([proposal]));

    expect(result.proposal.slots.map((s) => s.startTime)).toEqual(["13:00", "14:30"]);
    const joined = result.proposal.assumptions.join(" ");
    expect(joined).not.toContain("2pm");
    expect(joined).toContain("30 minutes");
    expect(joined).toContain("so I scheduled around that");
  });

  it("asks the trade-off question when the requested window has no room", async () => {
    // Wall-to-wall bookings covering the whole 13:00–17:00 window (and the hour after).
    const date = futureDate();
    for (let i = 0; i < 10; i++) {
      const hour = 13 + Math.floor(i / 2);
      const mins = i % 2 === 0 ? "00" : "30";
      await prisma.viewingSlot.create({
        data: {
          propertyId: "prop_sycamore",
          startsAt: new Date(`${date}T${String(hour).padStart(2, "0")}:${mins}:00`),
          durationMins: 30,
          maxAttendees: 5,
        },
      });
    }
    const llm = new MockLlm([validProposal()]);
    const result = await parseSlotRequest("slots at Sycamore Lane in the afternoon", llm);

    // Going outside the window is never a silent repair — it's the admin's call,
    // offered with the nearest out-of-window times and an escape hatch.
    expect(result.proposal.slots).toHaveLength(0);
    const q = result.proposal.clarifications[0]!;
    expect(q.question).toContain("within the time you asked for");
    expect(q.options).toEqual(["6:00pm", "6:30pm", "Another day"]);
  });

  it("accepts cancellations referencing grounded viewing ids and returns their details", async () => {
    const existing = await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T15:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const llm = new MockLlm([
      { slots: [], inviteeLeadIds: [], clarifications: [], cancelSlotIds: [existing.id] },
    ]);
    const result = await parseSlotRequest("cancel the 3pm viewing at Sycamore Lane", llm);

    expect(result.proposal.cancelSlotIds).toEqual([existing.id]);
    // The preview payload carries what's about to be cancelled.
    expect(result.existingSlots?.[0]?.id).toBe(existing.id);
    expect(result.existingSlots?.[0]?.property.name).toBe("17 Sycamore Lane");
  });

  it("rejects cancellations of hallucinated viewing ids", async () => {
    const bad = { slots: [], inviteeLeadIds: [], clarifications: [], cancelSlotIds: ["slot_invented"] };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("cancel something", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("accepts invitees for an existing viewing, dedupes them, and returns the viewing's details", async () => {
    const existing = await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T14:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const llm = new MockLlm([
      {
        slots: [],
        inviteeLeadIds: [],
        clarifications: [],
        addInvitees: [{ slotId: existing.id, leadIds: ["lead_kavanagh", "lead_kavanagh", "lead_sharma"] }],
      },
    ]);
    const result = await parseSlotRequest("send a few more invites to the 2pm slot", llm);

    expect(result.proposal.addInvitees).toEqual([
      { slotId: existing.id, leadIds: ["lead_kavanagh", "lead_sharma"] },
    ]);
    // An invite-only turn is an action, not a dead end — no forced-reply retry fired.
    expect(llm.requests).toHaveLength(1);
    // The preview payload carries the viewing being invited to.
    expect(result.existingSlots?.[0]?.id).toBe(existing.id);
  });

  it("rejects invitees pointed at hallucinated viewing ids or hallucinated leads", async () => {
    const existing = await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T14:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const badSlot = { slots: [], inviteeLeadIds: [], clarifications: [], addInvitees: [{ slotId: "slot_invented", leadIds: ["lead_kavanagh"] }] };
    await expect(parseSlotRequest("invite more people", new MockLlm([badSlot, badSlot]))).rejects.toBeInstanceOf(LlmOutputError);

    const badLead = { slots: [], inviteeLeadIds: [], clarifications: [], addInvitees: [{ slotId: existing.id, leadIds: ["lead_invented"] }] };
    await expect(parseSlotRequest("invite more people", new MockLlm([badLead, badLead]))).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("turns a reschedule onto an occupied time into a question, not a double-booking", async () => {
    const toMove = await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T10:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_sycamore",
        startsAt: new Date(`${futureDate()}T15:00:00`),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const llm = new MockLlm([
      {
        slots: [],
        inviteeLeadIds: [],
        clarifications: [],
        reschedules: [{ slotId: toMove.id, date: futureDate(), startTime: "15:00" }],
      },
    ]);
    const result = await parseSlotRequest("move the 10am viewing to 3pm", llm);

    expect(result.proposal.clarifications).toHaveLength(1);
    expect(result.proposal.clarifications[0]!.question).toContain("can't move it there");
    expect(result.proposal.clarifications[0]!.options).toContain("3:30pm");
  });

  it("persists nothing except the audit log (two-phase create)", async () => {
    const llm = new MockLlm([validProposal()]);
    await parseSlotRequest("three slots", llm);

    expect(await prisma.viewingSlot.count()).toBe(0);
    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.llmCallLog.count()).toBe(1);
  });
});
