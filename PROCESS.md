# Process — how AI tools were used to build this

The brief asks about use of AI coding tools, so this file is an honest log of how the work
actually happened. Tooling: Claude Code (Anthropic), used as the primary build tool
throughout.

## The working rules

The same rules I use on my own production project:

- **Design before code.** The architecture (DESIGN.md) was written and agreed in
  conversation before any implementation — the only thing ahead of it in the history is
  the empty workspace scaffold.
- **One intent per session.** Scoped changes over "while I was in there" bundling; the
  git history is the honest record of how well that held.
- **The agent proposes, checks decide.** Nothing is trusted because it looks right —
  the test suite (including LLM-garbage cases and the capacity race) is the arbiter.
- **Review before ship.** Anything I couldn't explain, I rewrote until I could — or cut.

## Log

### Day 1 — design + backend core
- Wrote DESIGN.md collaboratively (me deciding, AI drafting/challenging trade-offs:
  Express vs NestJS, SQLite vs Postgres, where capacity enforcement lives).
- Scaffolded workspaces, Prisma schema, seed data.
- Built the LLM integration: tool-forced structured output, Zod validation, repair retry,
  call audit log. Prompt design iterated against deliberately awkward inputs
  ("sometime next week", invented lead names, past dates).
- Tests written alongside: parser vs. garbage outputs, hallucinated ids, past dates,
  ambiguity path.

### Day 2 — self-review + frontend
- Post-review refactor: the repair-retry pipeline had been written twice (parse +
  drafting) — extracted into `validatedToolCall.ts` so the fence exists in one place.
- Docs wording pass: removed lines that read as commentary rather than engineering.
- Built the web app (admin composer → preview → confirm → draft/approve; invitee page
  with capacity + alternatives) and its 8 UI tests.
- First boot of the real server (as opposed to the mocked test suite) caught a real
  integration bug — see below.

### Day 3 — streaming, demo mode, design pass
- Streaming drafts (SSE): per-lead plain-text streamed calls (prose for a human editor)
  vs. the batched forced-tool call kept for parsing (structured data) — the output
  contract matches the consequence of the output.
- `LLM_MODE=mock`: a deterministic demo client behind the same `LlmClient` seam, so the
  full UX runs keyless. Fakes the model, never the fence; demo output visibly labelled.
- Two more integration bugs caught and logged below (env loading; test hermeticity).
- Design pass on both pages: restrained SaaS register, small component kit, the preview
  styled as the product's hero moment, streaming rendered with a live caret, invitee page
  given booking-confirmation treatment. All 8 UI tests survived unchanged — they assert
  on accessible labels, not markup.
- The design loop then became screenshot-driven: a Playwright script captures every app
  state, the screenshots get reviewed like a design crit, and the UI iterates against
  what it actually looks like — not what the code suggests it looks like. This caught
  two content bugs in the demo templates (repeated address, case-mangled notes) that no
  unit test would surface. Final register: the app floats as a rounded window over an
  ambient scene, prompt-box composer with embedded controls, outlined pill chips.

### Day 4 — the prompts meet the real model
- First live calls (claude-haiku-4-5): every parse valid on the first attempt — zero
  repair retries; 1.5–4.3s latency, ~$0.001/parse (real numbers in LlmCallLog).
- One behavioural deviation found and turned into a decision: the model auto-resolves an
  obvious single-candidate typo instead of asking "did you mean". Kept — the preview is
  already the confirmation gate — and the prompt updated to say so explicitly. The
  did-you-mean + corrections path remains for genuinely ambiguous names.
- Streaming drafts verified live end-to-end; the personalisation (lead notes → message
  content) is visibly working, not aspirational.

### Day 5 — "conversational": interrogating the brief instead of rebuilding

- Mid-build scare: the brief's repeated "conversational" raised the question of whether the
  admin view should really be a ChatGPT-style thread. Resolved by putting the brief's exact
  words in front of the AI rather than pattern-matching on vibes: the required admin view is
  specified as *input + structured preview + review panel*, and "conversationally" describes
  the input style, not the widget. Decision recorded in README ("Product decisions"):
  natural-language-first, not a chat log — a thread would bury the very components the brief
  asks to see.
- What the scare was actually pointing at shipped as three scoped changes instead of a
  rebuild: clarifying questions became structured and answerable in place (one-tap option
  chips + a reply box; the answer is appended to the visible request text, keeping the
  parse stateless), the model now returns `assumptions[]` so the preview shows *how* it
  read the request, and the admin's own words stay on screen above "Here's what I
  understood". A follow-up polish round made the assumptions *spoken*: the prompt requires
  first-person sentences with human dates ("I read 'next Tuesday' as Tuesday 21 July"),
  rendered inside the AI's closing bubble instead of a labelled panel of ISO strings —
  same data, but the machine voice is gone.
- Then a second, deliberate iteration on feel: the exchange was promoted to a visible
  thread — request, questions, and answers render as turns, with the preview arriving as
  the AI's closing turn. The line that survived both rounds: **conversation is
  presentation, the text is the state.** No message-history API, no server-side session;
  answers append to one request string ("edit the full request" collapses the thread back
  into it), and the structured preview/review panel never become chat bubbles. Also added
  Enter-to-send, because a surface that looks like a chat must key like one.
- Bonus catch while wiring the day-answer chips: the demo client always scheduled for
  Tuesday even when the request said Friday — surfaced because a chip answering "Friday"
  would have visibly created Tuesday slots. Fixed and pinned with a test.
- Conflict awareness became a doctrine case study. Grounding existing bookings in the
  prompt was necessary but not sufficient: live runs showed the model *seeing* the clash
  yet acting on it unreliably — one run raised it in `assumptions` while still proposing
  the clashing slot (Confirm would have double-booked), the next ignored it entirely.
  Rather than another round of prompt whack-a-mole, the guarantee moved into code. The
  first cut asked: strip the clashing slot, raise a clarification with free times as
  options. Real use immediately showed that to be correct but rude — a three-viewing
  request over a busy afternoon interrogated the admin once per clash. Second cut was
  repair-first: clashing slots deterministically moved to the nearest free times, spoken
  in assumptions. Real use broke that too — repairs escaped the admin's stated time range
  ("afternoon" requests landing at 6:30pm). Third cut bounds the repair with a
  model-extracted `window`: free movement inside the admin's words, and stepping outside
  them becomes a trade-off question with the nearest out-of-window times as options. The
  model proposes, deterministic code enforces — and relaxing the admin's own constraint
  is the one thing neither is allowed to do alone. Same round: a contradiction rule — a
  self-contradicting date ("Saturday the 27th" when the 27th is a Monday) now gets both
  readings offered as chips instead of a silent coin-flip.
- Also shipped this round: Vera the persona (greets the admin by name via the stubbed
  session, closes the loop after confirm with what was booked and what happens next —
  both composed client-side from known facts, deliberately not model calls), grounded
  weekday↔date calendar, one-question-per-turn with mandatory option chips, and
  multi-select chips for pick-several questions.

- Evening: NL management shipped (the brief's bulk-operations bonus, but really the core
  sentence — "create and *manage* viewing slots through natural language"). The booked
  list the model already sees for clash-grounding gained ids; the model proposes
  `cancelSlotIds`/`reschedules` against them; Zod rejects hallucinated ids; the confirm
  route re-validates and applies everything in one transaction. Cancels and moves render
  in the same preview (with "2 accepted — they'll need to be told" warnings) behind the
  same confirm gate. One trust bug caught live: the model narrated cancellations in the
  past tense before the admin had confirmed anything — fixed with an explicit prompt
  rule (intentions, never completed actions).

### Day 6 — adversarial QA and fresh-eyes review

- The feedback loop went autonomous: three scripted batteries (70 exchanges — normal
  usage, adversarial inputs, and semantic checks like "does 'next Monday' land on a
  Monday") ran against the live model, every response linted for the invariants (no
  clash, no hallucinated id, no past slot, no dead end, honest tense). The recurring
  lesson hardened into policy: **a prompt rule on a small model is a coin flip; a
  guarantee is a schema requirement or a deterministic post-check.** Concretely: an
  unanswered question now triggers a retry with `reply` made schema-required (the model
  physically can't dodge), an unmentioned time is never guessed (slots cleared, question
  asked — in code), one question per turn is enforced by truncation, and a clarification
  can never smuggle half-baked slots alongside it.
- Two independent review passes over the whole repo found what building-eyes had missed:
  accepting an alternative slot could orphan the invitee's own link (fixed as an atomic
  transfer — the URL's invitation is canonical and rows swap slots so every issued link
  keeps resolving), and confirmation trusted the previewed payload's times (fixed by
  re-running the no-double-booking check inside the write transaction — the preview
  repair is a convenience, the transaction is the guarantee). Also from review:
  provider errors normalised into the documented 502 and audit log, Dublin-wall-clock
  date grounding (toISOString hands the model yesterday's date for an hour a night in
  summer), declined-is-final enforced server-side, and a cancel+reschedule contradiction
  as a 422 instead of a 500.

## What the AI got wrong along the way

Recorded as they happen; see per-day notes above and commit messages. Mistakes get a line
here rather than being silently fixed — catching the model being wrong is where a process
like this earns its keep.

- **Day 2 — "zero-setup" was a claim, not a fact.** All 34 mocked tests were green, but
  the first real `npm run db:setup` on a machine with no `.env` failed: the DATABASE_URL
  default lived in the app's config module, while the Prisma CLI and generated client
  read the raw environment. The AI had written a default that only its own code could
  see. Caught by actually booting the app; fixed by writing the defaulted value back to
  `process.env` (and a shell-level default for the CLI), then re-verified with the env
  var explicitly unset. Lesson: mocked suites validate your logic, not your integration —
  nothing counts as "works" until it has run cold.
- **Day 2 — prefix-matching test mock.** The web tests' fetch mock matched routes by
  prefix, so `POST .../accept-alternative` was swallowed by the `.../accept` route and
  the alternatives test failed confusingly. Exact-match fixed it. Small, but a reminder
  that test infrastructure is code too.
- **Day 5 — the AI bypassed its own test harness.** It ran `npx vitest` directly instead
  of `npm test`, so the run inherited the local `.env` — the "no API key configured"
  test made a real Anthropic call and timed out, and twenty minutes went into diagnosing
  a "failure" that was actually the harness (`npm test` empties the key and points at a
  throwaway DB) being skipped. Side effect: the run's cleanup hooks wiped the seeded dev
  database, which had to be re-seeded. Lesson: entry points in `package.json` encode
  environment decisions; going around them discards those decisions silently.
- **Day 6 — the model re-answered old small talk.** "Conversation is presentation, the
  text is the state" had a blind spot: a chatty aside ("how are you?") appended to the
  request text got re-answered on every later turn — the admin asked for a list of
  viewings and was greeted twice first. The fix was architectural, not prompt-side:
  a turn that produces only a reply is a side-conversation and never joins the request
  text. Lesson: in a stateless design, deciding what *enters* the state is the design.
- **Day 6 — instructions the model follows half the time.** Told explicitly to answer a
  mid-flow question in the `reply` field, Haiku complied in roughly half of runs — even
  when the correction was quoted back verbatim. What worked was making `reply` a
  required field of the tool schema on retry: with forced tool use the model physically
  cannot omit it. Prompts persuade; schemas compel.
