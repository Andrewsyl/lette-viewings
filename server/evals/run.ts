// env.js first: it pins TZ=Europe/Dublin before any Date exists, exactly as the server does.
import { env, hasLlmKey } from "../src/env.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { prisma } from "../src/lib/db.js";
import { DRAFT_CASES, PARSE_CASES } from "./cases.js";
import { runDraftTrial, runParseTrial, type Outcome, type TrialResult } from "./harness.js";

// npm run eval -- [--suite parse|draft|all] [--reps N] [--case <id substring>]
//
// Every trial spends real tokens in live mode. LLM_MODE=mock runs the same harness
// against the deterministic demo client — free, and the way to check the harness itself.

const { values: args } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    reps: { type: "string", default: "1" },
    case: { type: "string" },
  },
});
const reps = Math.max(1, Number(args.reps) || 1);
const suites = args.suite === "all" ? ["parse", "draft"] : [args.suite!];

if (env.LLM_MODE === "live" && !hasLlmKey) {
  console.error("No ANTHROPIC_API_KEY — set one in server/.env, or run with LLM_MODE=mock to check the harness.");
  process.exit(1);
}

const model = env.LLM_MODE === "mock" ? "mock" : env.ANTHROPIC_MODEL;
const resultsRoot = join(import.meta.dirname, "results");
const runDir = join(resultsRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}_${model}`);
mkdirSync(runDir, { recursive: true });

const results: TrialResult[] = [];
let errorCount = 0;
function record(o: Outcome) {
  if ("result" in o) {
    results.push(o.result);
    appendFileSync(join(runDir, "results.jsonl"), JSON.stringify(o.result) + "\n");
    const fails = o.result.checks.filter((c) => !c.pass).map((c) => c.name);
    console.log(`${o.result.pass ? "  pass" : "  FAIL"}  ${o.result.caseId} #${o.result.rep}${fails.length ? `  — ${fails.join(", ")}` : ""}`);
  } else {
    errorCount++;
    appendFileSync(join(runDir, "errors.jsonl"), JSON.stringify(o.error) + "\n");
    console.log(`  ERR   ${o.error.caseId} #${o.error.rep}  — ${o.error.errorClass}: ${o.error.message}`);
  }
}

const matches = (id: string) => !args.case || id.includes(args.case);
console.log(`Model: ${model} · reps: ${reps} · suites: ${suites.join(", ")}\n`);

for (let rep = 1; rep <= reps; rep++) {
  if (suites.includes("parse")) {
    for (const c of PARSE_CASES.filter((c) => matches(c.id))) record(await runParseTrial(c, rep));
  }
  if (suites.includes("draft")) {
    for (const c of DRAFT_CASES.filter((c) => matches(c.id))) for (const o of await runDraftTrial(c, rep)) record(o);
  }
}

// ---------- Summary ----------

/** Pass rate with a 95% Wilson interval — with a few dozen trials the error bar is wide,
 *  and a difference smaller than it is noise, not a regression. */
function rate(pass: number, n: number) {
  if (n === 0) return { pass, n, rate: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = pass / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { pass, n, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const show = (r: ReturnType<typeof rate>) => `${pct(r.rate)} (${r.pass}/${r.n}, 95% range ${pct(r.lo)}–${pct(r.hi)})`;

const byGroup = new Map<string, TrialResult[]>();
for (const r of results) {
  const key = `${r.suite}:${r.tags[0]}`;
  byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
}
const byCase = new Map<string, TrialResult[]>();
for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
const checkFails = new Map<string, number>();
for (const r of results) for (const c of r.checks) if (!c.pass) checkFails.set(c.name, (checkFails.get(c.name) ?? 0) + 1);

const summary = {
  model,
  reps,
  dir: runDir,
  overall: rate(results.filter((r) => r.pass).length, results.length),
  groups: Object.fromEntries([...byGroup].map(([k, rs]) => [k, rate(rs.filter((r) => r.pass).length, rs.length)])),
  cases: Object.fromEntries([...byCase].map(([k, rs]) => [k, rate(rs.filter((r) => r.pass).length, rs.length)])),
  failedChecks: Object.fromEntries([...checkFails].sort((a, b) => b[1] - a[1])),
  errors: errorCount,
};

// Previous run for the same model, for a before/after on each case.
const previous = existsSync(resultsRoot)
  ? readdirSync(resultsRoot)
      .filter((d) => d.endsWith(`_${model}`) && join(resultsRoot, d) !== runDir && existsSync(join(resultsRoot, d, "summary.json")))
      .sort()
      .pop()
  : undefined;

writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\nOverall: ${show(summary.overall)}`);
for (const [k, r] of Object.entries(summary.groups)) console.log(`  ${k.padEnd(22)} ${show(r)}`);
if (Object.keys(summary.failedChecks).length) {
  console.log("\nMost-failed checks:");
  for (const [name, n] of Object.entries(summary.failedChecks).slice(0, 8)) console.log(`  ${String(n).padStart(3)}× ${name}`);
}
if (errorCount) console.log(`\n${errorCount} trial(s) errored before producing an answer — not counted above (see errors.jsonl).`);

if (previous) {
  const prev = JSON.parse(readFileSync(join(resultsRoot, previous, "summary.json"), "utf8")) as typeof summary;
  const changes = Object.entries(summary.cases)
    .map(([id, r]) => ({ id, now: r.rate, before: prev.cases[id]?.rate }))
    .filter((c) => c.before !== undefined && c.before !== c.now);
  console.log(`\nVs previous run (${previous}): overall ${pct(prev.overall.rate)} → ${pct(summary.overall.rate)}`);
  for (const c of changes) console.log(`  ${c.now > c.before! ? "better" : "WORSE "}  ${c.id}: ${pct(c.before!)} → ${pct(c.now)}`);
  if (changes.length === 0) console.log("  no case changed");
}
console.log(`\nFull transcripts: ${runDir}`);

await prisma.$disconnect();
