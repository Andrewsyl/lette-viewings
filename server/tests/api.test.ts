import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/db.js";
import { setLlmClient } from "../src/lib/llm.js";
import { MockLlm, resetDb, seedBasics, validProposal, futureDate } from "./helpers.js";

const app = createApp();

describe("API", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBasics();
    setLlmClient(null);
  });

  describe("POST /api/nl/parse", () => {
    it("returns a structured proposal for admin review", async () => {
      setLlmClient(new MockLlm([validProposal()]));
      const res = await request(app).post("/api/nl/parse").send({ text: "three 30-minute slots at Sycamore Lane at 2pm" });

      expect(res.status).toBe(200);
      expect(res.body.proposal.slots).toHaveLength(2);
      expect(res.body.properties).toHaveLength(1);
      expect(res.body.leads).toHaveLength(3);
    });

    it("422s with a friendly message when the model fails twice", async () => {
      setLlmClient(new MockLlm([{ junk: 1 }, { junk: 2 }]));
      const res = await request(app).post("/api/nl/parse").send({ text: "gibberish request" });

      expect(res.status).toBe(422);
      expect(res.body.message).toContain("couldn't reliably interpret");
    });

    it("502s cleanly when no LLM is configured (no key)", async () => {
      // No mock injected and no ANTHROPIC_API_KEY in the test env.
      const res = await request(app).post("/api/nl/parse").send({ text: "three slots at Sycamore Lane" });
      expect(res.status).toBe(502);
      expect(res.body.message).toContain("AI service is unavailable");
    });

    it("422s on an over-long input before any LLM call", async () => {
      const res = await request(app).post("/api/nl/parse").send({ text: "x".repeat(3000) });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /api/me", () => {
    it("returns the local git name for the greeting, or null — never a guessed persona", async () => {
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      // Environment-dependent (git identity present or not), but the invariant holds
      // everywhere: a real name or null, never the seeded demo persona's.
      expect(res.body.admin.name === null || res.body.admin.name.length > 0).toBe(true);
      expect(res.body.admin.name).not.toBe("Alex Byrne");
      expect(res.body.admin.email).toBe("alex@lette-demo.test");
    });
  });

  describe("POST /api/slots/confirm", () => {
    it("creates slots + pending invitations from the approved payload", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_kavanagh", "lead_sharma"],
        });

      expect(res.status).toBe(201);
      expect(res.body.slots).toHaveLength(1);
      expect(res.body.invitations).toHaveLength(2);
      expect(res.body.invitations.every((i: { status: string }) => i.status === "PENDING")).toBe(true);
    });

    it("rejects unknown leads — even an admin-approved payload is re-validated", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_forged"],
        });
      expect(res.status).toBe(422);
    });

    it("rejects past slots", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: "2020-01-01", startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_kavanagh"],
        });
      expect(res.status).toBe(422);
    });

    it("cancels viewings (and their invitations) from the approved payload", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T15:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      await prisma.invitation.create({ data: { slotId: slot.id, leadId: "lead_kavanagh" } });

      const res = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], cancelSlotIds: [slot.id] });

      expect(res.status).toBe(201);
      expect(res.body.cancelled).toHaveLength(1);
      expect(res.body.cancelled[0].id).toBe(slot.id);
      expect(await prisma.viewingSlot.count({ where: { id: slot.id } })).toBe(0);
      expect(await prisma.invitation.count({ where: { slotId: slot.id } })).toBe(0);
    });

    it("moves a viewing to its new time from the approved payload", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T10:00:00`), durationMins: 30, maxAttendees: 5 },
      });

      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [],
          inviteeLeadIds: [],
          reschedules: [{ slotId: slot.id, date: futureDate(), startTime: "16:00" }],
        });

      expect(res.status).toBe(201);
      expect(res.body.moved).toHaveLength(1);
      const updated = await prisma.viewingSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(updated.startsAt.getTime()).toBe(new Date(`${futureDate()}T16:00:00`).getTime());
    });

    it("rejects cancel/move of unknown viewings and empty payloads", async () => {
      const unknown = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], cancelSlotIds: ["slot_forged"] });
      expect(unknown.status).toBe(422);

      const empty = await request(app).post("/api/slots/confirm").send({ slots: [], inviteeLeadIds: [] });
      expect(empty.status).toBe(422);
    });

    it("422s when the same viewing is both cancelled and rescheduled", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T10:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [],
          inviteeLeadIds: [],
          cancelSlotIds: [slot.id],
          reschedules: [{ slotId: slot.id, date: futureDate(), startTime: "16:00" }],
        });
      expect(res.status).toBe(422);
      // Untouched: neither cancelled nor moved.
      const unchanged = await prisma.viewingSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(unchanged.startsAt.getTime()).toBe(new Date(`${futureDate()}T10:00:00`).getTime());
    });

    // The parse-time repair is a preview convenience — the no-double-booking invariant is
    // re-enforced at confirmation, inside the transaction. A stale or tampered payload
    // must 409, never write.
    it("409s a payload that would double-book an existing viewing", async () => {
      await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "14:15", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_kavanagh"],
        });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain("17 Sycamore Lane");
      expect(await prisma.viewingSlot.count()).toBe(1); // nothing written
    });

    it("409s a payload whose own slots overlap each other", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [
            { propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 },
            { propertyId: "prop_sycamore", date: futureDate(), startTime: "14:15", durationMins: 30, maxAttendees: 5 },
          ],
          inviteeLeadIds: [],
        });
      expect(res.status).toBe(409);
      expect(await prisma.viewingSlot.count()).toBe(0);
    });

    it("409s a reschedule that lands on another viewing", async () => {
      await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const toMove = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T10:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], reschedules: [{ slotId: toMove.id, date: futureDate(), startTime: "14:15" }] });
      expect(res.status).toBe(409);
      const unchanged = await prisma.viewingSlot.findUniqueOrThrow({ where: { id: toMove.id } });
      expect(unchanged.startsAt.getTime()).toBe(new Date(`${futureDate()}T10:00:00`).getTime());
    });

    it("allows a new slot in the time freed by a cancellation in the same payload", async () => {
      const cancelled = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: [],
          cancelSlotIds: [cancelled.id],
        });
      expect(res.status).toBe(201);
    });

    it("adds invitees to an existing viewing — invitations only, no new slots", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [],
          inviteeLeadIds: [],
          addInvitees: [{ slotId: slot.id, leadIds: ["lead_kavanagh", "lead_sharma"] }],
        });

      expect(res.status).toBe(201);
      expect(res.body.slots).toHaveLength(0);
      expect(res.body.invitedTo).toHaveLength(1);
      expect(res.body.invitedTo[0].id).toBe(slot.id);
      expect(res.body.invitations).toHaveLength(2);
      expect(res.body.invitations.every((i: { status: string; slotId: string }) => i.status === "PENDING" && i.slotId === slot.id)).toBe(true);
      expect(await prisma.viewingSlot.count()).toBe(1);
    });

    it("never re-invites: already-invited leads keep their invitation (and its link) untouched", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      const existing = await prisma.invitation.create({
        data: { slotId: slot.id, leadId: "lead_kavanagh", status: "ACCEPTED", message: "already sent" },
      });

      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [],
          inviteeLeadIds: [],
          // lead_kavanagh repeated within the payload AND already invited in the DB
          addInvitees: [{ slotId: slot.id, leadIds: ["lead_kavanagh", "lead_kavanagh", "lead_murphy"] }],
        });

      expect(res.status).toBe(201);
      // Only Conor's invitation is new — the response never re-lists Sarah's, so the
      // drafts panel can't re-draft a message that was already approved and sent.
      expect(res.body.invitations).toHaveLength(1);
      expect(res.body.invitations[0].lead.id).toBe("lead_murphy");
      const untouched = await prisma.invitation.findUniqueOrThrow({ where: { id: existing.id } });
      expect(untouched.status).toBe("ACCEPTED");
      expect(untouched.message).toBe("already sent");
      expect(await prisma.invitation.count({ where: { slotId: slot.id } })).toBe(2);
    });

    it("reports the targeted viewing even when everyone named was already invited", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });
      await prisma.invitation.create({ data: { slotId: slot.id, leadId: "lead_kavanagh" } });

      const res = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], addInvitees: [{ slotId: slot.id, leadIds: ["lead_kavanagh"] }] });

      expect(res.status).toBe(201);
      expect(res.body.invitedTo).toHaveLength(1);
      expect(res.body.invitations).toHaveLength(0);
    });

    it("rejects addInvitees contradictions and forged references", async () => {
      const slot = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(`${futureDate()}T14:00:00`), durationMins: 30, maxAttendees: 5 },
      });

      // Inviting to a viewing the same payload cancels is a contradiction, not a 500.
      const contradiction = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [],
          inviteeLeadIds: [],
          cancelSlotIds: [slot.id],
          addInvitees: [{ slotId: slot.id, leadIds: ["lead_kavanagh"] }],
        });
      expect(contradiction.status).toBe(422);

      const forgedSlot = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], addInvitees: [{ slotId: "slot_forged", leadIds: ["lead_kavanagh"] }] });
      expect(forgedSlot.status).toBe(422);

      const forgedLead = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], addInvitees: [{ slotId: slot.id, leadIds: ["lead_forged"] }] });
      expect(forgedLead.status).toBe(422);
    });

    it("rejects invitations to a viewing that already started", async () => {
      const past = await prisma.viewingSlot.create({
        data: { propertyId: "prop_sycamore", startsAt: new Date(Date.now() - 60 * 60 * 1000), durationMins: 30, maxAttendees: 5 },
      });
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({ slots: [], inviteeLeadIds: [], addInvitees: [{ slotId: past.id, leadIds: ["lead_kavanagh"] }] });
      expect(res.status).toBe(422);
    });
  });

  describe("invitation flow", () => {
    async function createSlotWithInvites() {
      const confirm = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "15:00", durationMins: 30, maxAttendees: 1 }],
          inviteeLeadIds: ["lead_kavanagh", "lead_sharma"],
        });
      return confirm.body as {
        slots: { id: string }[];
        invitations: { id: string; lead: { id: string } }[];
      };
    }

    it("approve saves the edited message and marks it sent", async () => {
      const { invitations } = await createSlotWithInvites();
      const res = await request(app)
        .post(`/api/invitations/${invitations[0]!.id}/approve`)
        .send({ message: "Hi Sarah — we'd love to show you 17 Sycamore Lane on Tuesday at 3pm." });

      expect(res.status).toBe(200);
      const view = await request(app).get(`/api/invitations/${invitations[0]!.id}`);
      expect(view.body.message).toContain("Sycamore Lane");
      expect(view.body.spotsRemaining).toBe(1);
    });

    it("accept enforces capacity over HTTP: 409 + alternatives when full", async () => {
      const { slots, invitations } = await createSlotWithInvites();

      // A later slot with room — the alternative the loser should be offered.
      await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(14), startTime: "15:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: [],
        });

      const first = await request(app).post(`/api/invitations/${invitations[0]!.id}/accept`);
      expect(first.status).toBe(200);
      expect(first.body.accepted).toBe(true);

      const second = await request(app).post(`/api/invitations/${invitations[1]!.id}/accept`);
      expect(second.status).toBe(409);
      expect(second.body.full).toBe(true);
      expect(second.body.alternatives.length).toBeGreaterThan(0);
      expect(second.body.alternatives[0].id).not.toBe(slots[0]!.id);

      // The loser takes the alternative — same guarded path.
      const move = await request(app)
        .post(`/api/invitations/${invitations[1]!.id}/accept-alternative`)
        .send({ slotId: second.body.alternatives[0].id });
      expect(move.status).toBe(200);
      expect(move.body.accepted).toBe(true);
    });

    it("404s for an unknown invitation", async () => {
      const res = await request(app).get("/api/invitations/inv_missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/invitations/draft", () => {
    it("drafts one reviewed message per lead without persisting anything", async () => {
      const { slots } = await createSlot();
      setLlmClient(
        new MockLlm([
          {
            drafts: [
              { leadId: "lead_kavanagh", message: "Hi Sarah — viewing at 17 Sycamore Lane this Tuesday; parking is easy on the street, which I know matters to you. Spaces are limited so do confirm." },
              { leadId: "lead_sharma", message: "Hi Priya — we have an evening-friendly viewing at 17 Sycamore Lane; it's a short walk from the hospital. Spaces are limited so do confirm." },
            ],
          },
        ])
      );

      const res = await request(app)
        .post("/api/invitations/draft")
        .send({ slotId: slots[0]!.id, leadIds: ["lead_kavanagh", "lead_sharma"] });

      expect(res.status).toBe(200);
      expect(res.body.drafts).toHaveLength(2);

      // Drafts are for review — nothing is saved until approve.
      const saved = await prisma.invitation.findMany({ where: { NOT: { message: null } } });
      expect(saved).toHaveLength(0);
    });

    async function createSlot() {
      const confirm = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_sycamore", date: futureDate(), startTime: "17:30", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_kavanagh", "lead_sharma"],
        });
      return confirm.body as { slots: { id: string }[] };
    }
  });
});
