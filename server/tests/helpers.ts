import { prisma } from "../src/lib/db.js";
import type { LlmClient, ToolCallRequest, ToolCallResult } from "../src/lib/llm.js";

/** Mock LLM: returns queued canned outputs (including deliberately malformed ones)
 *  and records every request so tests can assert on repair-retry behaviour. */
export class MockLlm implements LlmClient {
  requests: ToolCallRequest[] = [];
  private queue: unknown[];

  constructor(outputs: unknown[]) {
    this.queue = [...outputs];
  }

  async invokeTool(req: ToolCallRequest): Promise<ToolCallResult> {
    this.requests.push(req);
    if (this.queue.length === 0) throw new Error("MockLlm: no more queued outputs");
    const input = this.queue.shift();
    return { input, raw: JSON.stringify(input) };
  }
}

export async function resetDb() {
  await prisma.llmCallLog.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.viewingSlot.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.property.deleteMany();
  await prisma.adminUser.deleteMany();
}

export async function seedBasics() {
  await prisma.property.create({
    data: { id: "prop_maple", name: "22 Maple Street", address: "22 Maple Street, Dublin 6" },
  });
  await prisma.lead.createMany({
    data: [
      { id: "lead_johnson", name: "Sarah Johnson", email: "sarah@example.com", notes: "Asked about parking." },
      { id: "lead_patel", name: "Priya Patel", email: "priya@example.com", notes: "Evenings only." },
      { id: "lead_murphy", name: "Conor Murphy", email: "conor@example.com", notes: null },
    ],
  });
}

/** A date guaranteed to be in the future, formatted as the model would return it. */
export function futureDate(daysFromNow = 7): string {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function validProposal() {
  return {
    slots: [
      { propertyId: "prop_maple", date: futureDate(), startTime: "14:00", durationMins: 30, maxAttendees: 5 },
      { propertyId: "prop_maple", date: futureDate(), startTime: "14:30", durationMins: 30, maxAttendees: 5 },
    ],
    inviteeLeadIds: ["lead_johnson", "lead_patel"],
    clarifications: [],
  };
}
