# Server — Express + TypeScript + Prisma/SQLite

## Setup

```bash
# from the repo root:
npm run setup          # installs all workspaces + creates & seeds the database
npm run dev            # starts API (:4100) and web (:5173) together

# or server-only, from this directory:
npm run db:setup       # prisma db push + seed (SQLite file at prisma/dev.db)
npm run dev            # tsx watch, http://localhost:4100
npm test               # full suite — no API key needed (LLM mocked)
npm run typecheck
```

## Environment

Copy `.env.example` to `.env` for live LLM features. Everything else works with **no
`.env` at all** (the database defaults to `file:./dev.db`).

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Only for live NL parsing + drafting | Without it those endpoints return a clear 502; the rest of the app and the tests are unaffected |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-haiku-4-5` |
| `LLM_MODE` | No | `live` (default) or `mock` — a deterministic demo client for keyless demos; output is visibly labelled |
| `DATABASE_URL` | No | Defaults to `file:./dev.db` (path resolves next to `prisma/schema.prisma`) |
| `PORT` | No | Defaults to 4100 |

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/nl/parse` | NL → structured slot proposal (preview only, persists nothing) |
| `POST /api/slots/confirm` | Apply the admin-approved plan: create slots + invitations, cancel or move existing viewings |
| `GET /api/slots` | List slots with accepted counts |
| `POST /api/invitations/draft` | AI-draft personalised messages for review |
| `POST /api/invitations/:id/approve` | Save edited message, mark "sent" (simulated) |
| `GET /api/invitations/:id` | Invitee's view of their invitation |
| `POST /api/invitations/:id/accept` | Accept — 200 with spots remaining, or 409 + alternative slots |
| `POST /api/invitations/:id/accept-alternative` | Move to a suggested alternative (same capacity guard) |
| `GET /api/leads` | Lead roster |
| `GET /api/me` | The stubbed admin session (so the UI can greet the admin by name) |

Errors: Zod → 422 · LLM output invalid after one repair retry → 422 (friendly message) ·
LLM unavailable → 502 · slot full → 409 with alternatives · unknown id → 404.

## Structure

```
src/lib/llm.ts               Anthropic wrapper behind an LlmClient interface (test seam)
src/lib/validatedToolCall.ts THE fence: forced tool call → Zod → 1 repair retry → audit log
src/lib/parseSlots.ts        NL → proposal (grounded prompt, semantic validation)
src/lib/draftMessages.ts     Personalised invitation drafts (review-before-send)
src/lib/capacity.ts          Transactional accept + alternative suggestions
src/routes/*                 Thin routers; errors go to the central handler
prisma/schema.prisma         Data model incl. LlmCallLog (every model call audited)
tests/                       Parser-vs-garbage, capacity race, HTTP contract
```

See `../DESIGN.md` for the reasoning behind all of this.
