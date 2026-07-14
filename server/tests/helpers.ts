import { prisma } from "../src/lib/db.js";
import type { LlmClient, StreamTextRequest, ToolCallRequest, ToolCallResult } from "../src/lib/llm.js";

/** Mock LLM: returns queued canned outputs (including deliberately malformed ones)
 *  and records every request so tests can assert on repair-retry behaviour.
 *  `textOutputs` feeds streamText — each entry is streamed in two chunks; an entry of
 *  Error makes that stream fail. */
export class MockLlm implements LlmClient {
  requests: ToolCallRequest[] = [];
  streamRequests: StreamTextRequest[] = [];
  private queue: unknown[];
  private textQueue: (string | Error)[];

  constructor(outputs: unknown[], textOutputs: (string | Error)[] = []) {
    this.queue = [...outputs];
    this.textQueue = [...textOutputs];
  }

  async invokeTool(req: ToolCallRequest): Promise<ToolCallResult> {
    this.requests.push(req);
    if (this.queue.length === 0) throw new Error("MockLlm: no more queued outputs");
    const input = this.queue.shift();
    return { input, raw: JSON.stringify(input) };
  }

  async streamText(req: StreamTextRequest, onDelta: (text: string) => void): Promise<string> {
    this.streamRequests.push(req);
    if (this.textQueue.length === 0) throw new Error("MockLlm: no more queued text outputs");
    const next = this.textQueue.shift()!;
    if (next instanceof Error) throw next;
    const mid = Math.ceil(next.length / 2);
    onDelta(next.slice(0, mid));
    onDelta(next.slice(mid));
    return next;
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
