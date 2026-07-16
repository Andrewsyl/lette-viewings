# Process — how AI tools were used to build this

An honest log of how the work actually happened: the working rules, the session log, and
what the AI got wrong along the way. Tooling: Claude Code (Anthropic), used as the primary
build tool throughout.

## The working rules

The same rules I use on my own production project:

- **Design before code.** DESIGN.md was written and agreed before any implementation —
  the only thing ahead of it in the history is the empty workspace scaffold.
- **One intent per session.** Scoped changes over "while I was in there" bundling; the
  git history is the honest record of how well that held.
- **The agent proposes, checks decide.** Nothing is trusted because it looks right —
  the test suite (including LLM-garbage cases and the capacity race) is the arbiter.
- **Review before ship.** Anything I couldn't explain, I rewrote until I could — or cut.

## Log

Short single-intent sessions — logged per session; the git history is the timesheet.

**1 — Design + backend core.** DESIGN.md written collaboratively (AI drafting and
challenging trade-offs, me deciding). Schema, seed, and the LLM fence: forced tool call →
Zod → one repair retry → audit log, with tests firing garbage outputs, hallucinated ids
and past dates at it from the start.

**2 — Self-review + frontend.** Extracted the repair pipeline (written twice) into
`validatedToolCall.ts`. Built both pages and their UI tests. The first *real* boot caught
a real bug the 34 green mocked tests couldn't (below).

**3 — Streaming, demo mode, design pass.** SSE drafts — prose for a human editor gets a
lighter fence than structured data for a database; match the contract to the consequence.
`LLM_MODE=mock` behind the same client seam: fakes the model, never the fence. The design
loop went screenshot-driven (Playwright captures every state, reviewed like a crit) and
caught two content bugs no unit test would.

**4 — The prompts meet the real model.** First live calls: every parse valid on the first
attempt, ~$0.001 each (real numbers in LlmCallLog). One deviation became a decision:
obvious single-candidate typos auto-resolve — the preview is already the confirmation
gate — while ambiguous names still get "did you mean?" with one-tap corrections.

**5 — "Conversational", interrogated.** A mid-build scare — should this be a chat app? —
was settled by re-reading the requirements instead of pattern-matching on vibes: what
matters is input + structured preview + review panel, so it's a light thread over a
stateless parse.
**Conversation is presentation; the text is the state.** Clash handling took three cuts
to get right (ask → repair → repair bounded by the admin's stated time window): the
guarantee lives in code, and relaxing the admin's own constraint is the one thing neither
model nor code may do alone. Same session: NL cancel/reschedule through the same
preview → confirm gate, with Zod rejecting hallucinated viewing ids.

**6 — Adversarial QA + fresh-eyes review.** Three scripted batteries (70 exchanges) ran
against the live model, every response linted for the invariants — no clash, no id leak,
no past slot, no dead end. The policy that hardened: **a prompt rule on a small model is
a coin flip; a guarantee is a schema requirement or a deterministic post-check.** Review
passes then fixed what building-eyes had missed: alternative-accept could orphan an
invitee's link (now an atomic swap — every issued link keeps resolving), and confirm
trusted the previewed times (the no-double-booking check now re-runs inside the write
transaction — the preview repair is a convenience; the transaction is the guarantee).

**7 — Hands-on hardening, then stop.** Used the product like a property manager and fixed
what that surfaced, each with a regression test: "send a few more invites to the 2pm
slot" had no schema representation (became a real `addInvitees` operation), the preview's
reply bar answered above the plan it sits under (restructured), streamed drafts arrived
in chunks (display smoothing, no fake delay). Split the admin page into focused modules,
verified a fresh `git clone` cold, and stopped — what remains is DESIGN.md's scope-cuts
list, not unfinished work.

## What the AI got wrong along the way

Caught, recorded, fixed — catching the model being wrong is where a process like this
earns its keep.

- **"Zero-setup" was a claim until it ran cold.** All mocked tests green, but the first
  keyless boot failed: the AI wrote a DATABASE_URL default only its own code could see
  (Prisma's CLI reads the raw environment). Mocked suites validate logic, not integration.
- **A prefix-matching test mock** let `/accept` swallow `/accept-alternative` — a
  confusing "UI bug" that was test infrastructure. Test code is code too.
- **The README promised `.env`; nothing loaded it** — and the fix then leaked dev config
  into the test run. Tests aren't hermetic by default; hermeticity is built.
- **The AI bypassed its own test harness** (`npx vitest` instead of `npm test`), and
  twenty minutes went into a "failure" that was the skipped harness. Entry points encode
  environment decisions; going around them discards those decisions silently.
- **Old small talk got re-answered forever.** A chatty aside appended to the request text
  was re-answered on every later turn. The fix was architectural, not prompt-side:
  reply-only turns never join the state. Deciding what enters the state IS the design.
- **Instructions the model follows half the time.** Quoting the rule back didn't help;
  making `reply` schema-required on retry did — forced tool use can't omit it.
  Prompts persuade; schemas compel.
- **A capability hole made the model invent policy.** "Send a few more invites to the 2pm
  slot" had no schema representation, so the model hallucinated a refusal ("that's done
  through your property management system" — no such system exists). Fixed as a real
  operation through every layer, deduped so nobody is ever re-invited. A schema is also a
  scope statement: what it can't represent becomes a hallucination surface.
