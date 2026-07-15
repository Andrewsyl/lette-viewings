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

  it("atomically transfers when the lead already holds a pending invitation on the target slot", async () => {
    // Confirmation invites every lead to every slot, so this duplicate is the NORMAL case.
    // The invitation at the invitee's URL must end up accepted at the new slot — a refresh
    // of their link must never show the stale pending original — and the OTHER link must
    // survive too (swap, not delete): a lead's second emailed link must never 404.
    const fullSlot = await makeSlot({ maxAttendees: 1 });
    const altSlot = await makeSlot({ maxAttendees: 5, hoursFromNow: 72 });

    const winner = await invite(fullSlot.id, "lead_johnson");
    await acceptInvitation(winner.id);
    const urlInvitation = await invite(fullSlot.id, "lead_patel");
    const duplicate = await invite(altSlot.id, "lead_patel"); // pre-existing row for the target

    const outcome = await acceptAlternative(urlInvitation.id, altSlot.id);
    expect(outcome.kind).toBe("accepted");

    // The URL row is canonical: repointed and accepted…
    const canonical = await prisma.invitation.findUniqueOrThrow({ where: { id: urlInvitation.id } });
    expect(canonical.slotId).toBe(altSlot.id);
    expect(canonical.status).toBe("ACCEPTED");
    // …the other link's id still resolves, now offering the original slot, still open.
    const swapped = await prisma.invitation.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(swapped.slotId).toBe(fullSlot.id);
    expect(swapped.status).toBe("PENDING");
    // Exactly one seat is held across the pair.
    const accepted = await prisma.invitation.count({ where: { leadId: "lead_patel", status: "ACCEPTED" } });
    expect(accepted).toBe(1);
  });

  it("never moves an already-accepted invitee via a stale full-slot page", async () => {
    const slot = await makeSlot({ maxAttendees: 2 });
    const other = await makeSlot({ maxAttendees: 5, hoursFromNow: 72 });
    const inv = await invite(slot.id, "lead_johnson");
    await acceptInvitation(inv.id);

    const outcome = await acceptAlternative(inv.id, other.id);
    expect(outcome.kind).toBe("already-accepted");
    if (outcome.kind === "already-accepted") expect(outcome.slot.id).toBe(slot.id);

    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.slotId).toBe(slot.id); // seat untouched
  });

  it("a declined invitation stays declined — accept and accept-alternative both refuse", async () => {
    const slot = await makeSlot({ maxAttendees: 5 });
    const other = await makeSlot({ maxAttendees: 5, hoursFromNow: 72 });
    const inv = await prisma.invitation.create({
      data: { slotId: slot.id, leadId: "lead_johnson", status: "DECLINED" },
    });

    expect((await acceptInvitation(inv.id)).kind).toBe("declined");
    expect((await acceptAlternative(inv.id, other.id)).kind).toBe("declined");
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.status).toBe("DECLINED");
  });
});
