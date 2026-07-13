import { prisma } from "./db.js";
import { NotFoundError } from "./errors.js";
import type { SlotWithCounts } from "@lette/shared";

// Capacity enforcement lives here, inside a transaction: the ACCEPTED count is re-read
// inside the same transaction that flips the status, so two racing accepts cannot both
// see a free seat (SQLite serialises writers; on Postgres this same shape would take a
// SELECT ... FOR UPDATE on the slot row — see DESIGN.md).

export type AcceptOutcome =
  | { kind: "accepted"; slot: SlotWithCounts; spotsRemaining: number }
  | { kind: "full"; alternatives: SlotWithCounts[] }
  | { kind: "already-accepted"; slot: SlotWithCounts; spotsRemaining: number };

async function toSlotWithCounts(slotId: string): Promise<SlotWithCounts> {
  const slot = await prisma.viewingSlot.findUniqueOrThrow({
    where: { id: slotId },
    include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
  });
  return {
    id: slot.id,
    property: { id: slot.property.id, name: slot.property.name, address: slot.property.address },
    startsAt: slot.startsAt.toISOString(),
    durationMins: slot.durationMins,
    maxAttendees: slot.maxAttendees,
    acceptedCount: slot._count.invitations,
  };
}

/** Future, same-property, seats-available slots — the "no dead ends" payload. */
export async function findAlternatives(propertyId: string, excludeSlotId: string): Promise<SlotWithCounts[]> {
  const candidates = await prisma.viewingSlot.findMany({
    where: { propertyId, id: { not: excludeSlotId }, startsAt: { gt: new Date() } },
    include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
    orderBy: { startsAt: "asc" },
    take: 10,
  });
  return candidates
    .filter((slot) => slot._count.invitations < slot.maxAttendees)
    .slice(0, 3)
    .map((slot) => ({
      id: slot.id,
      property: { id: slot.property.id, name: slot.property.name, address: slot.property.address },
      startsAt: slot.startsAt.toISOString(),
      durationMins: slot.durationMins,
      maxAttendees: slot.maxAttendees,
      acceptedCount: slot._count.invitations,
    }));
}

export async function acceptInvitation(invitationId: string): Promise<AcceptOutcome> {
  const outcome = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: invitationId },
      include: { slot: true },
    });
    if (!invitation) throw new NotFoundError("Invitation not found");

    // Accepting twice is a no-op, not an error — refreshing the page after accepting
    // must never scare the invitee or eat a second seat.
    if (invitation.status === "ACCEPTED") return { kind: "already-accepted" as const, slotId: invitation.slotId };

    const acceptedCount = await tx.invitation.count({
      where: { slotId: invitation.slotId, status: "ACCEPTED" },
    });
    if (acceptedCount >= invitation.slot.maxAttendees) {
      return { kind: "full" as const, propertyId: invitation.slot.propertyId, slotId: invitation.slotId };
    }

    await tx.invitation.update({
      where: { id: invitationId },
      data: { status: "ACCEPTED" },
    });
    return { kind: "accepted" as const, slotId: invitation.slotId };
  });

  if (outcome.kind === "full") {
    return { kind: "full", alternatives: await findAlternatives(outcome.propertyId, outcome.slotId) };
  }
  const slot = await toSlotWithCounts(outcome.slotId);
  return { kind: outcome.kind, slot, spotsRemaining: slot.maxAttendees - slot.acceptedCount };
}

/** Move a (non-accepted or bumped) invitation to an alternative slot, through the same guarded path. */
export async function acceptAlternative(invitationId: string, newSlotId: string): Promise<AcceptOutcome> {
  const moved = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { id: invitationId }, include: { slot: true } });
    if (!invitation) throw new NotFoundError("Invitation not found");

    const newSlot = await tx.viewingSlot.findUnique({ where: { id: newSlotId } });
    if (!newSlot) throw new NotFoundError("Alternative slot not found");
    if (newSlot.propertyId !== invitation.slot.propertyId) {
      throw new NotFoundError("Alternative slot is not for this property");
    }

    const acceptedCount = await tx.invitation.count({
      where: { slotId: newSlotId, status: "ACCEPTED" },
    });
    if (acceptedCount >= newSlot.maxAttendees) {
      return { kind: "full" as const, propertyId: newSlot.propertyId, slotId: newSlotId };
    }

    // Reuse the existing invitation row (message and all) pointed at the new slot —
    // unless one already exists for that slot+lead, in which case accept that instead
    // (the @@unique constraint is the real referee here).
    const existing = await tx.invitation.findUnique({
      where: { slotId_leadId: { slotId: newSlotId, leadId: invitation.leadId } },
    });
    if (existing) {
      await tx.invitation.update({ where: { id: existing.id }, data: { status: "ACCEPTED" } });
      return { kind: "accepted" as const, slotId: newSlotId };
    }
    await tx.invitation.update({
      where: { id: invitationId },
      data: { slotId: newSlotId, status: "ACCEPTED" },
    });
    return { kind: "accepted" as const, slotId: newSlotId };
  });

  if (moved.kind === "full") {
    return { kind: "full", alternatives: await findAlternatives((await prisma.viewingSlot.findUniqueOrThrow({ where: { id: newSlotId } })).propertyId, newSlotId) };
  }
  const slot = await toSlotWithCounts(moved.slotId);
  return { kind: "accepted", slot, spotsRemaining: slot.maxAttendees - slot.acceptedCount };
}
