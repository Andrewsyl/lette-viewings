import { describe, it, expect, beforeEach } from "vitest";
import { parseSlotRequest } from "../src/lib/parseSlots.js";
import { DemoLlmClient } from "../src/lib/demoLlm.js";
import { resetDb, seedBasics } from "./helpers.js";
import { prisma } from "../src/lib/db.js";

// The demo client (LLM_MODE=mock) powers keyless demos — its output must pass the same
// Zod fence as the real model, and its matching must behave sensibly.

describe("DemoLlmClient through the real parse pipeline", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
    await prisma.lead.create({
      data: { id: "lead_walsh", name: "Emma Walsh", email: "emma@example.com", notes: null },
    });
  });

  it("produces a proposal that passes the full validation fence", async () => {
    const result = await parseSlotRequest(
      "three 30-minute viewing slots for 22 Maple Street next Tuesday, max 5, invite Johnson and Patel",
      new DemoLlmClient()
    );
    expect(result.proposal.slots).toHaveLength(3);
    expect(result.proposal.inviteeLeadIds).toEqual(
      expect.arrayContaining(["lead_johnson", "lead_patel"])
    );
    expect(result.proposal.clarifications).toHaveLength(0);
  });

  it("matches leads by first name, not just surname", async () => {
    const result = await parseSlotRequest(
      "two slots at Maple Street next Tuesday, invite Emma",
      new DemoLlmClient()
    );
    expect(result.proposal.inviteeLeadIds).toContain("lead_walsh");
  });

  it("asks instead of silently dropping an unmatched invitee", async () => {
    const result = await parseSlotRequest(
      "slots at Maple Street next Tuesday, invite Bob",
      new DemoLlmClient()
    );
    expect(result.proposal.inviteeLeadIds).toHaveLength(0);
    expect(result.proposal.clarifications.length).toBeGreaterThan(0);
  });

  it("asks about the unmatched person even when others matched (no partial silent drop)", async () => {
    const result = await parseSlotRequest(
      "two slots at Maple Street next Tuesday, invite Emma and Bob",
      new DemoLlmClient()
    );
    expect(result.proposal.clarifications.map((c) => c.question).join(" ")).toContain('"Bob"');
    expect(result.proposal.slots).toHaveLength(0);
  });

  it("suggests the closest lead for a typo'd name, with a machine-usable correction", async () => {
    const result = await parseSlotRequest(
      "two slots at Maple Street next Tuesday, invite Pryia",
      new DemoLlmClient()
    );
    expect(result.proposal.clarifications.map((c) => c.question).join(" ")).toContain("Did you mean Priya Patel");
    expect(result.proposal.corrections).toEqual([{ from: "Pryia", to: "Priya Patel" }]);
    expect(result.proposal.inviteeLeadIds).toHaveLength(0);
  });

  it("catches lowercase unknown names alongside a successful match (people type lowercase)", async () => {
    const result = await parseSlotRequest(
      "two slots at Maple Street next Tuesday, invite emma and bob",
      new DemoLlmClient()
    );
    expect(result.proposal.clarifications.map((c) => c.question).join(" ")).toContain('"bob"');
    expect(result.proposal.slots).toHaveLength(0);
  });

  it("does not mistake weekdays or property words in the invite clause for names", async () => {
    const result = await parseSlotRequest(
      "two slots next Tuesday, invite Johnson on Tuesday at Maple Street",
      new DemoLlmClient()
    );
    expect(result.proposal.clarifications).toHaveLength(0);
    expect(result.proposal.inviteeLeadIds).toContain("lead_johnson");
  });

  it("asks for a specific day on vague timing, with one-tap day options", async () => {
    const result = await parseSlotRequest("some viewings next week sometime", new DemoLlmClient());
    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications.length).toBeGreaterThan(0);
    expect(result.proposal.clarifications[0]!.options).toContain("Tuesday");
  });

  it("resolves once the vague request carries an answered clarification", async () => {
    const answered =
      'some viewings next week sometime for Maple Street, invite Johnson\n\nClarification — "Which day would you like the viewings?": Friday';
    const result = await parseSlotRequest(answered, new DemoLlmClient());
    expect(result.proposal.clarifications).toHaveLength(0);
    expect(result.proposal.slots.length).toBeGreaterThan(0);
    // The answer is honoured, not the demo's fallback day.
    expect(new Date(result.proposal.slots[0]!.date).getDay()).toBe(5);
  });

  it("schedules on the day the admin actually named", async () => {
    const result = await parseSlotRequest(
      "two viewings at Maple Street on Friday morning, invite Johnson",
      new DemoLlmClient()
    );
    expect(new Date(result.proposal.slots[0]!.date).getDay()).toBe(5);
    expect(result.proposal.slots[0]!.startTime).toBe("09:00");
  });

  it("answers a capability question with a reply, not an empty proposal", async () => {
    const result = await parseSlotRequest("can you delete viewings", new DemoLlmClient());
    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications).toHaveLength(0);
    expect(result.proposal.reply).toContain("viewing");
  });

  it("answers 'list viewings' from the grounded booked list", async () => {
    await prisma.viewingSlot.create({
      data: {
        propertyId: "prop_maple",
        startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        durationMins: 30,
        maxAttendees: 5,
      },
    });
    const result = await parseSlotRequest("list viewings", new DemoLlmClient());
    expect(result.proposal.reply).toContain("1 upcoming viewing");
  });

  it("surfaces its defaults and readings as assumptions", async () => {
    const result = await parseSlotRequest(
      "viewings at Maple Street next Tuesday afternoon, invite Johnson",
      new DemoLlmClient()
    );
    const joined = result.proposal.assumptions.join(" ");
    expect(joined).toContain('"afternoon"');
    expect(joined).toContain("30-minute");
    expect(joined).toContain("5 people");
  });
});
