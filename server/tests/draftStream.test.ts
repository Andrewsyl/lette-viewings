import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/db.js";
import { streamDraftMessages } from "../src/lib/draftStream.js";
import type { DraftStreamEvent } from "@lette/shared";
import { MockLlm, resetDb, seedBasics } from "./helpers.js";

const GOOD_DRAFT =
  "Hi Sarah — we'd love to show you 22 Maple Street this Tuesday at 2pm. Street parking is easy nearby, which I know matters to you. Spaces are limited, so do confirm if you can make it.";

async function makeSlot() {
  return prisma.viewingSlot.create({
    data: {
      propertyId: "prop_maple",
      startsAt: new Date(Date.now() + 48 * 3600 * 1000),
      durationMins: 30,
      maxAttendees: 5,
    },
  });
}

function collect(events: DraftStreamEvent[]) {
  return (event: DraftStreamEvent) => events.push(event);
}

describe("streamDraftMessages", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
  });

  it("streams deltas then a done event per lead, ending with complete", async () => {
    const slot = await makeSlot();
    const llm = new MockLlm([], [GOOD_DRAFT, GOOD_DRAFT.replace("Sarah", "Priya")]);
    const events: DraftStreamEvent[] = [];

    await streamDraftMessages(
      { slotId: slot.id, leadIds: ["lead_johnson", "lead_patel"] },
      collect(events),
      llm
    );

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "done")).toHaveLength(2);
    expect(types.filter((t) => t === "delta").length).toBeGreaterThanOrEqual(4);
    expect(types.at(-1)).toBe("complete");

    // Reassembling the deltas for a lead must equal that lead's final message.
    const johnsonDeltas = events
      .filter((e): e is Extract<DraftStreamEvent, { type: "delta" }> => e.type === "delta" && e.leadId === "lead_johnson")
      .map((e) => e.text)
      .join("");
    const johnsonDone = events.find(
      (e): e is Extract<DraftStreamEvent, { type: "done" }> => e.type === "done" && e.leadId === "lead_johnson"
    );
    expect(johnsonDone?.message).toBe(johnsonDeltas.trim());
  });

  it("one lead failing emits an error event and the rest continue", async () => {
    const slot = await makeSlot();
    const llm = new MockLlm([], [new Error("model exploded"), GOOD_DRAFT]);
    const events: DraftStreamEvent[] = [];

    await streamDraftMessages(
      { slotId: slot.id, leadIds: ["lead_johnson", "lead_patel"] },
      collect(events),
      llm
    );

    expect(events.some((e) => e.type === "error" && e.leadId === "lead_johnson")).toBe(true);
    expect(events.some((e) => e.type === "done" && e.leadId === "lead_patel")).toBe(true);
    expect(events.at(-1)?.type).toBe("complete");
  });

  it("rejects out-of-bounds drafts as errors (too short = model junk, not a message)", async () => {
    const slot = await makeSlot();
    const llm = new MockLlm([], ["ok."]);
    const events: DraftStreamEvent[] = [];

    await streamDraftMessages({ slotId: slot.id, leadIds: ["lead_johnson"] }, collect(events), llm);

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("audits every streamed call, including failures", async () => {
    const slot = await makeSlot();
    const llm = new MockLlm([], [GOOD_DRAFT, new Error("boom")]);

    await streamDraftMessages(
      { slotId: slot.id, leadIds: ["lead_johnson", "lead_patel"] },
      () => {},
      llm
    );

    const logs = await prisma.llmCallLog.findMany({ where: { kind: "draft_invitation_stream" } });
    expect(logs).toHaveLength(2);
    expect(logs.filter((l) => l.parsedOk)).toHaveLength(1);
    expect(logs.filter((l) => !l.parsedOk)).toHaveLength(1);
  });
});
