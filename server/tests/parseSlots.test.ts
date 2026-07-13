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
    const result = await parseSlotRequest("three slots for Maple St", llm);

    expect(result.proposal.slots).toHaveLength(2);
    expect(result.proposal.inviteeLeadIds).toEqual(["lead_johnson", "lead_patel"]);
    expect(llm.requests).toHaveLength(1);

    const log = await prisma.llmCallLog.findFirstOrThrow();
    expect(log.kind).toBe("parse_slots");
    expect(log.parsedOk).toBe(true);
  });

  it("repairs once when the first output is garbage, and succeeds", async () => {
    const llm = new MockLlm([{ nonsense: true }, validProposal()]);
    const result = await parseSlotRequest("slots please", llm);

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
      slots: [{ propertyId: "prop_maple", date: "2020-01-01", startTime: "10:00", durationMins: 30, maxAttendees: 5 }],
    };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("slots for 2020", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("rejects out-of-bounds duration and capacity", async () => {
    const bad = {
      ...validProposal(),
      slots: [{ propertyId: "prop_maple", date: futureDate(), startTime: "10:00", durationMins: 0, maxAttendees: 5000 }],
    };
    const llm = new MockLlm([bad, bad]);
    await expect(parseSlotRequest("a strange slot", llm)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("passes ambiguity through as clarifications, not guesses", async () => {
    const ambiguous = {
      slots: [],
      inviteeLeadIds: [],
      clarifications: ["Which day next week would you like the viewings?"],
    };
    const llm = new MockLlm([ambiguous]);
    const result = await parseSlotRequest("some viewings next week sometime", llm);

    expect(result.proposal.slots).toHaveLength(0);
    expect(result.proposal.clarifications).toHaveLength(1);
  });

  it("persists nothing except the audit log (two-phase create)", async () => {
    const llm = new MockLlm([validProposal()]);
    await parseSlotRequest("three slots", llm);

    expect(await prisma.viewingSlot.count()).toBe(0);
    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.llmCallLog.count()).toBe(1);
  });
});
