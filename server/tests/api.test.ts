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
      const res = await request(app).post("/api/nl/parse").send({ text: "three 30-minute slots at Maple St" });

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
      const res = await request(app).post("/api/nl/parse").send({ text: "three slots at Maple St" });
      expect(res.status).toBe(502);
      expect(res.body.message).toContain("AI service is unavailable");
    });

    it("422s on an over-long input before any LLM call", async () => {
      const res = await request(app).post("/api/nl/parse").send({ text: "x".repeat(3000) });
      expect(res.status).toBe(422);
    });
  });

  describe("POST /api/slots/confirm", () => {
    it("creates slots + pending invitations from the approved payload", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_maple", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_johnson", "lead_patel"],
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
          slots: [{ propertyId: "prop_maple", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_forged"],
        });
      expect(res.status).toBe(422);
    });

    it("rejects past slots", async () => {
      const res = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_maple", date: "2020-01-01", startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_johnson"],
        });
      expect(res.status).toBe(422);
    });
  });

  describe("invitation flow", () => {
    async function createSlotWithInvites() {
      const confirm = await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_maple", date: futureDate(), startTime: "15:00", durationMins: 30, maxAttendees: 1 }],
          inviteeLeadIds: ["lead_johnson", "lead_patel"],
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
        .send({ message: "Hi Sarah — we'd love to show you 22 Maple Street on Tuesday at 3pm." });

      expect(res.status).toBe(200);
      const view = await request(app).get(`/api/invitations/${invitations[0]!.id}`);
      expect(view.body.message).toContain("Maple Street");
      expect(view.body.spotsRemaining).toBe(1);
    });

    it("accept enforces capacity over HTTP: 409 + alternatives when full", async () => {
      const { slots, invitations } = await createSlotWithInvites();

      // A later slot with room — the alternative the loser should be offered.
      await request(app)
        .post("/api/slots/confirm")
        .send({
          slots: [{ propertyId: "prop_maple", date: futureDate(14), startTime: "15:00", durationMins: 30, maxAttendees: 5 }],
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
              { leadId: "lead_johnson", message: "Hi Sarah — viewing at 22 Maple Street this Tuesday; parking is easy on the street, which I know matters to you. Spaces are limited so do confirm." },
              { leadId: "lead_patel", message: "Hi Priya — we have an evening-friendly viewing at 22 Maple Street; it's a short walk from the hospital. Spaces are limited so do confirm." },
            ],
          },
        ])
      );

      const res = await request(app)
        .post("/api/invitations/draft")
        .send({ slotId: slots[0]!.id, leadIds: ["lead_johnson", "lead_patel"] });

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
          slots: [{ propertyId: "prop_maple", date: futureDate(), startTime: "17:30", durationMins: 30, maxAttendees: 5 }],
          inviteeLeadIds: ["lead_johnson", "lead_patel"],
        });
      return confirm.body as { slots: { id: string }[] };
    }
  });
});
