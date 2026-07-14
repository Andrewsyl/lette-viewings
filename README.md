# Lette Viewings — AI-Powered Viewing Slot Invitations

A property manager describes viewings in plain English → the AI proposes structured slots
and personalised invitations → the admin reviews and approves → invitees book themselves
in, with capacity enforced and alternative times offered when a slot is full.

The design principle throughout: **the LLM proposes, a human approves, deterministic code
enforces.** Model output never reaches the database or an invitee without passing a schema
fence and a human gate. `DESIGN.md` has the reasoning.

## Quick start

```bash
npm run setup     # installs workspaces + creates & seeds the SQLite database
npm run dev       # API on :4100 and web on :5173 together
npm test          # full suite (server + web) — runs WITHOUT any API key (LLM mocked)
```

For live AI features: `cp server/.env.example server/.env` and set `ANTHROPIC_API_KEY`.
Everything else — including the whole test suite — works with no key and no `.env`.

**No API key?** Put `LLM_MODE=mock` in `server/.env` to run the full UX against a
deterministic demo client: same validation fences, same streaming UI, and every message
is visibly labelled as demo output so it can't be mistaken for the real model.

## Try it

1. Open http://localhost:5173/admin
2. Use the example prompt (or type your own): *"Set up three 30-minute viewing slots for
   22 Maple Street next Tuesday afternoon, max 5 people each, and invite the Johnson and
   Patel leads"*
3. Review the parsed preview → **Confirm & create**
4. **Draft invitations with AI** — messages stream in live, personalised from each lead's
   notes (Sarah asked about parking; Priya works evenings) — edit freely → **Approve & send**
5. Open a sent invitation's link to see the invitee view → **Accept**
6. To see the full-slot flow: create a slot with `max 1`, invite two leads, accept as
   both — the second gets alternative times instead of a dead end. Try *"some viewings
   next week sometime"* to see ambiguity handled with a question instead of a guess.

## Layout

| Path | What |
|---|---|
| `server/` | Express + TS + Prisma/SQLite. LLM fence, capacity logic, audit log. [README](server/README.md) |
| `web/` | Vite + React + Tailwind. Admin composer + invitee page. [README](web/README.md) |
| `shared/types.ts` | The API contract, imported by both sides |
| `DESIGN.md` | Architecture decisions and trade-offs, written before the code |

## What was deliberately cut (Pareto), and what I'd do with more time

**Cut for scope, in the order I'd build them next:**

1. **Postgres + database-level capacity guarantee.** SQLite keeps reviewer setup at zero;
   the transactional re-count closes the race there (proven by a concurrent-accept test).
   Multi-instance production needs the check *in* the database — `SELECT ... FOR UPDATE`
   on the slot row, or a constraint/trigger that makes overfill impossible regardless of
   application bugs.
2. **Real invitee auth.** The invitation id doubles as the access link today (brief allows
   stubbed auth); real version is a signed, expiring token.
3. **Lead creation inside the flow.** An unknown invitee currently produces a question
   ("I couldn't find Bob — they may need to be added as a lead first"); the real version
   should offer to capture them on the spot ("give me an email and I'll add him"),
   because every unknown name is an acquisition opportunity, not an error. It's a new
   mutation surface, so it's cut and named. (Typos are already handled: "invite Pryia"
   asks "Did you mean Priya Patel?".)
4. **Bulk NL operations** ("cancel all viewings for Maple Street", "move Tuesday's to
   Wednesday"). Same parse → preview → confirm pattern, new mutation surface — the
   two-phase architecture already accommodates it.
5. **Smart defaults from history.** Learn per-property duration/capacity norms and feed
   them into the prompt as defaults; needs usage data to be meaningful.
6. **An eval harness.** `LlmCallLog` is already accumulating real inputs and outputs;
   replaying them against prompt changes turns prompt edits from guesswork into a
   regression suite. At real volume this is the first thing I'd build.
7. **Decline flow, lead management UI, pagination, rate limiting** — standard production
   furniture, wrong complexity for this stage.

**Known trade-offs accepted:** naive local times (Europe/Dublin assumed, no cross-timezone
handling) · single admin · drafts stream sequentially per lead (parallel streams are easy
but make the demo harder to follow) · SQLite test databases force sequential test files.
