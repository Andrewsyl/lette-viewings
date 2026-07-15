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
  | { kind: "already-accepted"; slot: SlotWithCounts; spotsRemaining: number }
  | { kind: "declined" };

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
    // A declined invitation stays declined — flipping DECLINED→ACCEPTED silently would
    // let a stale link resurrect a decision the lead already made.
    if (invitation.status === "DECLINED") return { kind: "declined" as const };

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

  if (outcome.kind === "declined") return outcome;
  if (outcome.kind === "full") {
    return { kind: "full", alternatives: await findAlternatives(outcome.propertyId, outcome.slotId) };
  }
  const slot = await toSlotWithCounts(outcome.slotId);
  return { kind: outcome.kind, slot, spotsRemaining: slot.maxAttendees - slot.acceptedCount };
}

/** Move a pending invitation to an alternative slot — an atomic transfer. The invitation
 *  at the invitee's URL is canonical: it is REPOINTED to the new slot, so a refresh of
 *  their link always shows the accepted state. A duplicate row for the same slot+lead
 *  (confirmation invites every lead to every slot) is absorbed into the canonical one. */
export async function acceptAlternative(invitationId: string, newSlotId: string): Promise<AcceptOutcome> {
  const moved = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { id: invitationId }, include: { slot: true } });
    if (!invitation) throw new NotFoundError("Invitation not found");
    // An accepted invitee already holds a seat — a stale "slot full" page must not
    // silently move them. Their real booking wins.
    if (invitation.status === "ACCEPTED") {
      return { kind: "already-accepted" as const, slotId: invitation.slotId };
    }
    if (invitation.status === "DECLINED") return { kind: "declined" as const };

    const newSlot = await tx.viewingSlot.findUnique({ where: { id: newSlotId } });
    if (!newSlot) throw new NotFoundError("Alternative slot not found");
    if (newSlot.propertyId !== invitation.slot.propertyId) {
      throw new NotFoundError("Alternative slot is not for this property");
    }

    // A duplicate invitation for the target slot+lead blocks the repoint (unique
    // constraint) — the normal case, since confirmation invites every lead to every
    // slot. If the lead DECLINED that slot via its own link, that decision is final.
    // If it's ACCEPTED, they already hold the seat, so the capacity check is skipped —
    // a full slot must not bounce its own attendee.
    const existing = await tx.invitation.findUnique({
      where: { slotId_leadId: { slotId: newSlotId, leadId: invitation.leadId } },
    });
    if (existing?.status === "DECLINED") return { kind: "declined" as const };
    const alreadyHoldsSeat = existing?.status === "ACCEPTED";
    if (!alreadyHoldsSeat) {
      const acceptedCount = await tx.invitation.count({
        where: { slotId: newSlotId, status: "ACCEPTED" },
      });
      if (acceptedCount >= newSlot.maxAttendees) {
        return { kind: "full" as const, propertyId: newSlot.propertyId, slotId: newSlotId };
      }
    }
    if (existing) {
      // SWAP, don't delete: every issued link must stay resolvable. The URL row takes
      // the target slot (and the message drafted for that time); the other link's id is
      // recreated pointing at the original slot with the message drafted for IT. Net
      // state is identical to before — only the ids' slot assignments trade places —
      // so neither link dies and no message describes the wrong viewing.
      const original = { slotId: invitation.slotId, message: invitation.message, approvedAt: invitation.approvedAt };
      await tx.invitation.delete({ where: { id: existing.id } });
      await tx.invitation.update({
        where: { id: invitationId },
        data: { slotId: newSlotId, status: "ACCEPTED", message: existing.message, approvedAt: existing.approvedAt },
      });
      await tx.invitation.create({
        data: {
          id: existing.id,
          slotId: original.slotId,
          leadId: invitation.leadId,
          // An ACCEPTED duplicate's seat just moved to the URL row; its recreated
          // counterpart at the old slot is an open invitation again.
          status: "PENDING",
          message: original.message,
          approvedAt: original.approvedAt,
        },
      });
      return { kind: "accepted" as const, slotId: newSlotId };
    }
    await tx.invitation.update({
      where: { id: invitationId },
      data: { slotId: newSlotId, status: "ACCEPTED" },
    });
    return { kind: "accepted" as const, slotId: newSlotId };
  });

  if (moved.kind === "declined") return moved;
  if (moved.kind === "full") {
    return { kind: "full", alternatives: await findAlternatives((await prisma.viewingSlot.findUniqueOrThrow({ where: { id: newSlotId } })).propertyId, newSlotId) };
  }
  const slot = await toSlotWithCounts(moved.slotId);
  return { kind: moved.kind, slot, spotsRemaining: slot.maxAttendees - slot.acceptedCount };
}
