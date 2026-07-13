import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
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
    .min(1)
    .max(20),
  inviteeLeadIds: z.array(z.string()).max(50),
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

    const created = await prisma.$transaction(async (tx) => {
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
      await tx.invitation.createMany({
        data: slotRows.flatMap((row) => body.inviteeLeadIds.map((leadId) => ({ slotId: row.id, leadId }))),
      });
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
