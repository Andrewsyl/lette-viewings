import { prisma } from "../src/lib/db.js";
import { parseSlotRequest } from "../src/lib/parseSlots.js";
import { streamDraftMessages } from "../src/lib/draftStream.js";
import { LlmOutputError } from "../src/lib/errors.js";
import type { LlmClient } from "../src/lib/llm.js";
import { LEADS, PROPERTIES, resetWorld } from "./fixtures.js";
import { daysFrom, type DraftCase, type ParseCase } from "./cases.js";
import { gradeDraft, spokenTextIsClean, type Check } from "./grade.js";

// One trial = one (case, rep) on a freshly reset database, through the app's REAL entry
// points (parseSlotRequest / streamDraftMessages) — so the prompt, the repair retry and
// every code fence are exactly what ships. That also means a pass is the admin's
// experience, not the raw model's: a fence that rescues a bad output counts as a pass.
// The model's own first answer is kept in `calls` for when that difference matters.

export interface TrialResult {
  suite: "parse" | "draft";
  caseId: string;
  rep: number;
  tags: string[];
  pass: boolean;
  checks: Check[];
  input: string;
  output: unknown;
  /** Every model call the trial made, from the app's own audit log. */
  calls: { kind: string; input: string; parsedOk: boolean; error: string | null; rawOutput: string | null; latencyMs: number }[];
  latencyMs: number;
}

/** A trial that never produced a gradable answer (provider down, harness bug) — kept out
 *  of the pass rate so plumbing is never scored as the model's failure. */
export interface TrialError {
  suite: "parse" | "draft";
  caseId: string;
  rep: number;
  errorClass: "provider" | "harness";
  message: string;
}

export type Outcome = { result: TrialResult } | { error: TrialError };

async function auditCalls() {
  const rows = await prisma.llmCallLog.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    kind: r.kind, input: r.input, parsedOk: r.parsedOk, error: r.error, rawOutput: r.rawOutput, latencyMs: r.latencyMs,
  }));
}

export async function runParseTrial(c: ParseCase, rep: number, llm?: LlmClient): Promise<Outcome> {
  const d = daysFrom(new Date());
  await resetWorld(c.booked?.(d) ?? []);
  const input = c.text(d);
  const started = Date.now();
  try {
    const { proposal } = await parseSlotRequest(input, llm);
    const checks = [...c.grade(proposal, d), ...spokenTextIsClean(proposal)];
    return {
      result: {
        suite: "parse", caseId: c.id, rep, tags: c.tags, pass: checks.every((ch) => ch.pass), checks,
        input, output: proposal, calls: await auditCalls(), latencyMs: Date.now() - started,
      },
    };
  } catch (err) {
    // Invalid output twice in a row is the model's failure, and the admin sees it (a 422).
    if (err instanceof LlmOutputError) {
      const checks = [{ name: "valid output after repair retry", pass: false, detail: JSON.stringify(err.details).slice(0, 300) }];
      return {
        result: {
          suite: "parse", caseId: c.id, rep, tags: c.tags, pass: false, checks,
          input, output: null, calls: await auditCalls(), latencyMs: Date.now() - started,
        },
      };
    }
    return { error: classify("parse", c.id, rep, err) };
  }
}

export async function runDraftTrial(c: DraftCase, rep: number, llm?: LlmClient): Promise<Outcome[]> {
  const d = daysFrom(new Date());
  const slot = c.slot(d);
  const leadIds = c.leads.map((l) => l.leadId);
  await resetWorld([{ ...slot, inviteeLeadIds: leadIds }]);
  const property = PROPERTIES.find((p) => p.id === slot.propertyId)!;
  const weekday = new Date(`${slot.date}T12:00:00`).toLocaleDateString("en-IE", { weekday: "long" });

  const done = new Map<string, string>();
  const failed = new Set<string>();
  const started = Date.now();
  try {
    await streamDraftMessages({ slotId: slot.id, leadIds }, (event) => {
      if (event.type === "done") done.set(event.leadId, event.message);
      if (event.type === "error") failed.add(event.leadId);
    }, llm);
  } catch (err) {
    return [{ error: classify("draft", c.id, rep, err) }];
  }
  const calls = await auditCalls();
  const latencyMs = Date.now() - started;

  // Drafts run per lead, so each lead is its own graded row.
  return c.leads.map(({ leadId, expect }): Outcome => {
    const caseId = `${c.id}/${expect.firstName.toLowerCase()}`;
    const leadName = LEADS.find((l) => l.id === leadId)!.name;
    const call = calls.find((x) => x.input.includes(`LEAD: ${leadName}`));
    if (failed.has(leadId)) {
      // The stream path logs a length violation as the model's fault; anything else
      // (network, provider) never produced text to grade.
      if (call?.error?.startsWith("draft length")) {
        return {
          result: {
            suite: "draft", caseId, rep, tags: c.tags, pass: false,
            checks: [{ name: "length 40–1500 chars", pass: false, detail: call.error }],
            input: leadId, output: call.rawOutput, calls: call ? [call] : [], latencyMs,
          },
        };
      }
      return { error: { suite: "draft", caseId, rep, errorClass: "provider", message: call?.error ?? "draft failed" } };
    }
    const message = done.get(leadId) ?? "";
    const checks = gradeDraft(message, { ...expect, propertyName: property.name, weekday, time: slot.startTime });
    return {
      result: {
        suite: "draft", caseId, rep, tags: c.tags, pass: checks.every((ch) => ch.pass), checks,
        input: leadId, output: message, calls: call ? [call] : [], latencyMs,
      },
    };
  });
}

function classify(suite: "parse" | "draft", caseId: string, rep: number, err: unknown): TrialError {
  const status = (err as { status?: number })?.status;
  return {
    suite, caseId, rep,
    errorClass: status === 502 ? "provider" : "harness",
    message: err instanceof Error ? err.message : String(err),
  };
}
