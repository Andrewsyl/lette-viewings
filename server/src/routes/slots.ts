import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { ConflictError } from "../lib/errors.js";
import type { ConfirmResponse, SlotWithCounts } from "@lette/shared";

const router = Router();

// Phase 2: the ADMIN-APPROVED payload is what persists. Re-validated from scratch —
// the client (and by extension the LLM output it previewed) is never trusted.
const confirmBody = z.object({
  slots: z
    .array(
      z.object({
        propertyId: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        durationMins: z.number().int().min(5).max(240),
        maxAttendees: z.number().int().min(1).max(50),
      })
    )
    .max(20),
  inviteeLeadIds: z.array(z.string()).max(50),
  cancelSlotIds: z.array(z.string()).max(20).optional().default([]),
  reschedules: z
    .array(
      z.object({
        slotId: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
    )
    .max(20)
    .optional()
    .default([]),
}).superRefine((body, ctx) => {
  // A viewing can't be both cancelled and moved — the transaction would delete it and
  // then try to update the deleted row. Contradiction is a payload error, not a 500.
  const cancels = new Set(body.cancelSlotIds);
  for (const r of body.reschedules) {
    if (cancels.has(r.slotId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reschedules"],
        message: `Viewing ${r.slotId} appears in both cancelSlotIds and reschedules — it can be cancelled or moved, not both`,
      });
    }
  }
});

function slotToDto(slot: {
  id: string;
  startsAt: Date;
  durationMins: number;
  maxAttendees: number;
  property: { id: string; name: string; address: string };
  _count: { invitations: number };
}): SlotWithCounts {
  return {
    id: slot.id,
    property: slot.property,
    startsAt: slot.startsAt.toISOString(),
    durationMins: slot.durationMins,
    maxAttendees: slot.maxAttendees,
    acceptedCount: slot._count.invitations,
  };
}

router.post("/confirm", async (req, res, next) => {
  try {
    const body = confirmBody.parse(req.body);

    if (body.slots.length + body.cancelSlotIds.length + body.reschedules.length === 0) {
      return res.status(422).json({ message: "Nothing to do — no viewings, cancellations or moves in payload" });
    }
    const propertyIds = [...new Set(body.slots.map((s) => s.propertyId))];
    const properties = await prisma.property.findMany({ where: { id: { in: propertyIds } } });
    if (properties.length !== propertyIds.length) {
      return res.status(422).json({ message: "Unknown property in payload" });
    }
    const leads = await prisma.lead.findMany({ where: { id: { in: body.inviteeLeadIds } } });
    if (leads.length !== body.inviteeLeadIds.length) {
      return res.status(422).json({ message: "Unknown lead in payload" });
    }
    for (const slot of body.slots) {
      if (new Date(`${slot.date}T${slot.startTime}:00`) <= new Date()) {
        return res.status(422).json({ message: "Slot start must be in the future" });
      }
    }
    // Cancel/move targets must exist — the client (and the LLM output behind it) is
    // never trusted to reference real viewings.
    const touchedIds = [...new Set([...body.cancelSlotIds, ...body.reschedules.map((r) => r.slotId)])];
    const touched = await prisma.viewingSlot.findMany({
      where: { id: { in: touchedIds } },
      include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
    });
    if (touched.length !== touchedIds.length) {
      return res.status(422).json({ message: "Unknown viewing in cancel/move payload" });
    }
    for (const r of body.reschedules) {
      if (new Date(`${r.date}T${r.startTime}:00`) <= new Date()) {
        return res.status(422).json({ message: "Rescheduled start must be in the future" });
      }
    }

    // Details captured before deletion — the response tells the admin what went away.
    const cancelledDtos = touched.filter((t) => body.cancelSlotIds.includes(t.id)).map(slotToDto);

    const created = await prisma.$transaction(async (tx) => {
      // The parse-time clash repair is a preview convenience, not the guarantee. The
      // payload could be stale (someone booked between preview and confirm) or modified —
      // so the no-double-booking invariant is re-checked HERE, inside the transaction,
      // against the post-operation timeline: existing viewings minus cancellations, with
      // reschedules at their new times, plus each new slot in turn. SQLite serialises
      // writers, so nothing can slip in between this check and the writes below.
      {
        const cancelSet = new Set(body.cancelSlotIds);
        const reschedMap = new Map(body.reschedules.map((r) => [r.slotId, r]));
        const all = await tx.viewingSlot.findMany({ include: { property: true } });
        type Entry = { propertyId: string; start: number; mins: number; name: string };
        const overlap = (a: Entry, b: Entry) =>
          a.propertyId === b.propertyId &&
          a.start < b.start + b.mins * 60_000 &&
          b.start < a.start + a.mins * 60_000;
        const timeline: Entry[] = all
          .filter((s) => !cancelSet.has(s.id) && !reschedMap.has(s.id))
          .map((s) => ({ propertyId: s.propertyId, start: s.startsAt.getTime(), mins: s.durationMins, name: s.property.name }));
        for (const r of body.reschedules) {
          const origin = all.find((s) => s.id === r.slotId)!;
          const entry: Entry = {
            propertyId: origin.propertyId,
            start: new Date(`${r.date}T${r.startTime}:00`).getTime(),
            mins: origin.durationMins,
            name: origin.property.name,
          };
          if (timeline.some((t) => overlap(t, entry))) {
            throw new ConflictError(
              `Moving that viewing would double-book ${entry.name} — the new time overlaps another viewing. Re-check the plan and try again.`
            );
          }
          timeline.push(entry);
        }
        for (const slot of body.slots) {
          const name = properties.find((p) => p.id === slot.propertyId)?.name ?? "the property";
          const entry: Entry = {
            propertyId: slot.propertyId,
            start: new Date(`${slot.date}T${slot.startTime}:00`).getTime(),
            mins: slot.durationMins,
            name,
          };
          if (timeline.some((t) => overlap(t, entry))) {
            throw new ConflictError(
              `${entry.name} already has a viewing overlapping ${slot.date} ${slot.startTime} — the calendar may have changed since the preview. Re-check the plan and try again.`
            );
          }
          timeline.push(entry);
        }
      }
      if (body.cancelSlotIds.length > 0) {
        await tx.invitation.deleteMany({ where: { slotId: { in: body.cancelSlotIds } } });
        await tx.viewingSlot.deleteMany({ where: { id: { in: body.cancelSlotIds } } });
      }
      for (const r of body.reschedules) {
        await tx.viewingSlot.update({
          where: { id: r.slotId },
          data: { startsAt: new Date(`${r.date}T${r.startTime}:00`) },
        });
      }
      const slotRows = [];
      for (const slot of body.slots) {
        const row = await tx.viewingSlot.create({
          data: {
            propertyId: slot.propertyId,
            startsAt: new Date(`${slot.date}T${slot.startTime}:00`),
            durationMins: slot.durationMins,
            maxAttendees: slot.maxAttendees,
          },
        });
        slotRows.push(row);
      }
      if (slotRows.length > 0 && body.inviteeLeadIds.length > 0) {
        await tx.invitation.createMany({
          data: slotRows.flatMap((row) => body.inviteeLeadIds.map((leadId) => ({ slotId: row.id, leadId }))),
        });
      }
      return slotRows;
    });

    const slots = await prisma.viewingSlot.findMany({
      where: { id: { in: created.map((s) => s.id) } },
      include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
      orderBy: { startsAt: "asc" },
    });
    const invitations = await prisma.invitation.findMany({
      where: { slotId: { in: created.map((s) => s.id) } },
      include: { lead: true },
    });
    const movedIds = body.reschedules.map((r) => r.slotId);
    const moved =
      movedIds.length > 0
        ? await prisma.viewingSlot.findMany({
            where: { id: { in: movedIds } },
            include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
            orderBy: { startsAt: "asc" },
          })
        : [];

    const response: ConfirmResponse = {
      slots: slots.map(slotToDto),
      invitations: invitations.map((inv) => ({
        id: inv.id,
        slotId: inv.slotId,
        lead: { id: inv.lead.id, name: inv.lead.name, email: inv.lead.email, notes: inv.lead.notes },
        status: inv.status as ConfirmResponse["invitations"][number]["status"],
        message: inv.message,
        approvedAt: inv.approvedAt?.toISOString() ?? null,
      })),
      ...(cancelledDtos.length > 0 ? { cancelled: cancelledDtos } : {}),
      ...(moved.length > 0 ? { moved: moved.map(slotToDto) } : {}),
    };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const slots = await prisma.viewingSlot.findMany({
      include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
      orderBy: { startsAt: "asc" },
    });
    res.json({ slots: slots.map(slotToDto) });
  } catch (err) {
    next(err);
  }
});

export default router;
