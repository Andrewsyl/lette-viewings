import { describe, it, expect } from "vitest";
import { PARSE_CASES, DRAFT_CASES, daysFrom } from "../evals/cases.js";
import { runDraftTrial, runParseTrial, type TrialResult } from "../evals/harness.js";
import { MockLlm } from "./helpers.js";

// The eval harness is only worth trusting if a right answer passes and a wrong one fails.
// These feed it canned model output (no API key): an oracle that should score 100%,
// and plausible-but-wrong answers that must not.

const parseCase = (id: string) => PARSE_CASES.find((c) => c.id === id)!;
const result = (o: Awaited<ReturnType<typeof runParseTrial>>) => {
  if (!("result" in o)) throw new Error(`trial errored: ${o.error.message}`);
  return o.result as TrialResult;
};

function proposal(over: Record<string, unknown>) {
  return { slots: [], inviteeLeadIds: [], clarifications: [], assumptions: [], window: { earliest: "13:00", latest: "19:00" }, ...over };
}

describe("eval harness", () => {
  it("passes a correct proposal (oracle)", async () => {
    const d = daysFrom(new Date());
    const llm = new MockLlm([
      proposal({
        slots: ["14:00", "14:30", "15:00"].map((startTime) => ({ propertyId: "prop_sycamore", date: d.thursday, startTime, durationMins: 30, maxAttendees: 5 })),
        inviteeLeadIds: ["lead_kavanagh", "lead_sharma"],
        assumptions: ["I'll run them back to back from 2pm."],
      }),
    ]);
    const r = result(await runParseTrial(parseCase("explicit-three-from-2pm"), 1, llm));
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.calls).toHaveLength(1);
  });

  it("fails a plausible wrong answer — right property, wrong day", async () => {
    const d = daysFrom(new Date());
    const llm = new MockLlm([
      proposal({
        slots: [{ propertyId: "prop_sycamore", date: d.friday, startTime: "14:00", durationMins: 30, maxAttendees: 5 }],
        inviteeLeadIds: ["lead_kavanagh", "lead_sharma"],
      }),
    ]);
    const r = result(await runParseTrial(parseCase("explicit-three-from-2pm"), 1, llm));
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === "right day")?.pass).toBe(false);
  });

  it("fails an empty answer (null baseline)", async () => {
    // Empty twice (the dead-end retry fires) — nothing proposed, nothing said.
    const llm = new MockLlm([proposal({}), proposal({})]);
    const r = result(await runParseTrial(parseCase("whats-booked"), 1, llm));
    expect(r.pass).toBe(false);
  });

  it("fails leaked internal ids in what Vera says", async () => {
    const llm = new MockLlm([proposal({ reply: "slot_bot_thu at prop_phibs is booked on Thursday at 2pm." })]);
    const r = result(await runParseTrial(parseCase("whats-booked"), 1, llm));
    // humanize() swaps property ids for names in code, so prop_ is fixed — slot ids are not.
    expect(r.checks.find((c) => c.name === "no internal ids in what Vera says")?.pass).toBe(false);
  });

  it("scores two invalid outputs as a model failure, not an error", async () => {
    const llm = new MockLlm([{ nonsense: true }, { nonsense: true }]);
    const r = result(await runParseTrial(parseCase("no-time"), 1, llm));
    expect(r.pass).toBe(false);
    expect(r.checks[0]!.name).toBe("valid output after repair retry");
  });

  it("keeps provider failures out of the pass rate", async () => {
    const llm = new MockLlm([]); // throws — stands in for an unreachable provider
    const o = await runParseTrial(parseCase("no-time"), 1, {
      invokeTool: async () => { const e = new Error("down") as Error & { status: number }; e.status = 502; throw e; },
      streamText: llm.streamText.bind(llm),
    });
    expect("error" in o && o.error.errorClass).toBe("provider");
  });

  it("grades each drafted message on its own", async () => {
    const c = DRAFT_CASES.find((x) => x.id === "sycamore-thursday-2pm")!;
    const good = (name: string, extra: string) =>
      `Hi ${name}, I'd love to show you 17 Sycamore Lane in Ranelagh this ${new Date(`${daysFrom(new Date()).thursday}T12:00:00`).toLocaleDateString("en-IE", { weekday: "long" })} at 2pm. ` +
      `The viewing runs for thirty minutes and gives you a proper look around the rooms, the kitchen and the garden. ${extra} ` +
      "Spaces are limited to five people, so please reply to confirm your place as soon as you can. " +
      "If the time doesn't suit, just let me know and we can look at another option that works better for you. Looking forward to meeting you there.";
    // Answer by the lead named in the request, whatever order the leads load in.
    const outcomes = await runDraftTrial(c, 1, {
      invokeTool: async () => { throw new Error("unused"); },
      streamText: async (req, onDelta) => {
        const text = req.user.includes("Sarah")
          ? good("Sarah", "There is off-street parking for one car, which I know you asked about.")
          : good("Conor", "It is a lovely spot close to shops, cafes and the Luas line.");
        onDelta(text);
        return text;
      },
    });
    const rs = outcomes.map((o) => ("result" in o ? o.result : null));
    expect(rs.map((r) => r?.caseId).sort()).toEqual(["sycamore-thursday-2pm/conor", "sycamore-thursday-2pm/sarah"]);
    for (const r of rs) expect(r?.checks.filter((ch) => !ch.pass)).toEqual([]);
  });
});
