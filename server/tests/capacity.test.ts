import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/db.js";
import { acceptInvitation, acceptAlternative } from "../src/lib/capacity.js";
import { resetDb, seedBasics } from "./helpers.js";

async function makeSlot(opts: { maxAttendees: number; hoursFromNow?: number }) {
  return prisma.viewingSlot.create({
    data: {
      propertyId: "prop_maple",
      startsAt: new Date(Date.now() + (opts.hoursFromNow ?? 48) * 3600 * 1000),
      durationMins: 30,
      maxAttendees: opts.maxAttendees,
    },
  });
}

async function invite(slotId: string, leadId: string) {
  return prisma.invitation.create({ data: { slotId, leadId } });
}

describe("capacity enforcement", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
  });

  it("accepts while seats remain and reports spots remaining", async () => {
    const slot = await makeSlot({ maxAttendees: 2 });
    const inv = await invite(slot.id, "lead_johnson");

    const outcome = await acceptInvitation(inv.id);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") expect(outcome.spotsRemaining).toBe(1);
  });

  it("is idempotent: accepting twice neither errors nor eats a second seat", async () => {
    const slot = await makeSlot({ maxAttendees: 2 });
    const inv = await invite(slot.id, "lead_johnson");

    await acceptInvitation(inv.id);
    const second = await acceptInvitation(inv.id);
    expect(second.kind).toBe("already-accepted");

    const accepted = await prisma.invitation.count({ where: { slotId: slot.id, status: "ACCEPTED" } });
    expect(accepted).toBe(1);
  });

  it("returns alternatives (same property, future, seats free) when full", async () => {
    const fullSlot = await makeSlot({ maxAttendees: 1 });
    const alternative = await makeSlot({ maxAttendees: 5, hoursFromNow: 72 });
    // A past slot and a full slot must never be suggested.
    await makeSlot({ maxAttendees: 5, hoursFromNow: -24 });

    const winner = await invite(fullSlot.id, "lead_johnson");
    await acceptInvitation(winner.id);

    const loser = await invite(fullSlot.id, "lead_patel");
    const outcome = await acceptInvitation(loser.id);

    expect(outcome.kind).toBe("full");
    if (outcome.kind === "full") {
      expect(outcome.alternatives.map((a) => a.id)).toEqual([alternative.id]);
    }
  });

  it("closes the race: two concurrent accepts for the last seat produce exactly one winner", async () => {
    const slot = await makeSlot({ maxAttendees: 1 });
    const a = await invite(slot.id, "lead_johnson");
    const b = await invite(slot.id, "lead_patel");

    const [ra, rb] = await Promise.all([acceptInvitation(a.id), acceptInvitation(b.id)]);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["accepted", "full"]);

    const accepted = await prisma.invitation.count({ where: { slotId: slot.id, status: "ACCEPTED" } });
    expect(accepted).toBe(1);
  });

  it("moves an invitation to an alternative slot through the same guarded path", async () => {
    const fullSlot = await makeSlot({ maxAttendees: 1 });
    const altSlot = await makeSlot({ maxAttendees: 1, hoursFromNow: 72 });

    const winner = await invite(fullSlot.id, "lead_johnson");
    await acceptInvitation(winner.id);
    const loser = await invite(fullSlot.id, "lead_patel");

    const outcome = await acceptAlternative(loser.id, altSlot.id);
    expect(outcome.kind).toBe("accepted");

    const moved = await prisma.invitation.findUniqueOrThrow({ where: { id: loser.id } });
    expect(moved.slotId).toBe(altSlot.id);
    expect(moved.status).toBe("ACCEPTED");
  });

  it("accept-alternative also enforces capacity on the target slot", async () => {
    const fullSlot = await makeSlot({ maxAttendees: 1 });
    const altSlot = await makeSlot({ maxAttendees: 1, hoursFromNow: 72 });

    // Fill the alternative first.
    const altWinner = await invite(altSlot.id, "lead_murphy");
    await acceptInvitation(altWinner.id);

    const winner = await invite(fullSlot.id, "lead_johnson");
    await acceptInvitation(winner.id);
    const loser = await invite(fullSlot.id, "lead_patel");

    const outcome = await acceptAlternative(loser.id, altSlot.id);
    expect(outcome.kind).toBe("full");
  });
});
