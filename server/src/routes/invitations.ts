import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { draftInvitationMessages } from "../lib/draftMessages.js";
import { streamDraftMessages } from "../lib/draftStream.js";
import { acceptInvitation, acceptAlternative } from "../lib/capacity.js";
import { NotFoundError } from "../lib/errors.js";
import type { DraftResponse, InvitationView, SlotFullResponse } from "@lette/shared";

const router = Router();

const draftBody = z.object({ slotId: z.string(), leadIds: z.array(z.string()).min(1).max(20) });

// Drafts are returned for review — NOT saved. The admin-approved text is what persists.
router.post("/draft", async (req, res, next) => {
  try {
    const body = draftBody.parse(req.body);
    const drafts = await draftInvitationMessages(body);
    const response: DraftResponse = { drafts };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Streaming variant: server-sent events, one plain-text streamed model call per lead.
// Errors after headers are sent can't become HTTP status codes — they become error
// events, and the client falls back or lets the admin write manually.
router.post("/draft/stream", async (req, res, next) => {
  let body: z.infer<typeof draftBody>;
  try {
    body = draftBody.parse(req.body);
  } catch (err) {
    return next(err);
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  try {
    await streamDraftMessages(body, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Drafting failed";
    res.write(`data: ${JSON.stringify({ type: "complete", fatal: message })}\n\n`);
  }
  res.end();
});

const approveBody = z.object({ message: z.string().min(10).max(3000) });

// Save the (possibly edited) message and mark the invitation "sent" (simulated send).
router.post("/:id/approve", async (req, res, next) => {
  try {
    const { message } = approveBody.parse(req.body);
    const updated = await prisma.invitation.updateMany({
      where: { id: req.params.id },
      data: { message, approvedAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundError("Invitation not found");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Invitee-facing view: the invitation id doubles as the access token (deliberate stub — see DESIGN.md).
router.get("/:id", async (req, res, next) => {
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: req.params.id },
      include: {
        lead: true,
        slot: {
          include: { property: true, _count: { select: { invitations: { where: { status: "ACCEPTED" } } } } },
        },
      },
    });
    if (!invitation) throw new NotFoundError("Invitation not found");

    const response: InvitationView = {
      id: invitation.id,
      status: invitation.status as InvitationView["status"],
      message: invitation.message,
      lead: {
        id: invitation.lead.id,
        name: invitation.lead.name,
        email: invitation.lead.email,
        notes: invitation.lead.notes,
      },
      slot: {
        id: invitation.slot.id,
        property: invitation.slot.property,
        startsAt: invitation.slot.startsAt.toISOString(),
        durationMins: invitation.slot.durationMins,
        maxAttendees: invitation.slot.maxAttendees,
        acceptedCount: invitation.slot._count.invitations,
      },
      spotsRemaining: invitation.slot.maxAttendees - invitation.slot._count.invitations,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/accept", async (req, res, next) => {
  try {
    const outcome = await acceptInvitation(req.params.id);
    if (outcome.kind === "declined") {
      return res.status(409).json({ accepted: false, declined: true, message: "This invitation was declined and can no longer be accepted." });
    }
    if (outcome.kind === "full") {
      const body: SlotFullResponse = { accepted: false, full: true, alternatives: outcome.alternatives };
      return res.status(409).json(body);
    }
    res.json({ accepted: true, slot: outcome.slot, spotsRemaining: outcome.spotsRemaining });
  } catch (err) {
    next(err);
  }
});

const acceptAltBody = z.object({ slotId: z.string() });

router.post("/:id/accept-alternative", async (req, res, next) => {
  try {
    const { slotId } = acceptAltBody.parse(req.body);
    const outcome = await acceptAlternative(req.params.id, slotId);
    if (outcome.kind === "declined") {
      return res.status(409).json({ accepted: false, declined: true, message: "This invitation was declined and can no longer be accepted." });
    }
    if (outcome.kind === "full") {
      const body: SlotFullResponse = { accepted: false, full: true, alternatives: outcome.alternatives };
      return res.status(409).json(body);
    }
    res.json({ accepted: true, slot: outcome.slot, spotsRemaining: outcome.spotsRemaining });
  } catch (err) {
    next(err);
  }
});

// Admin list (per slot) so the review panel can show invitation state.
router.get("/", async (req, res, next) => {
  try {
    const slotId = typeof req.query.slotId === "string" ? req.query.slotId : undefined;
    const invitations = await prisma.invitation.findMany({
      where: slotId ? { slotId } : undefined,
      include: { lead: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({
      invitations: invitations.map((inv) => ({
        id: inv.id,
        slotId: inv.slotId,
        lead: { id: inv.lead.id, name: inv.lead.name, email: inv.lead.email, notes: inv.lead.notes },
        status: inv.status,
        message: inv.message,
        approvedAt: inv.approvedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
