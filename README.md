# Lette Viewings — AI-Powered Viewing Slot Invitations

Take-home challenge: property managers create viewing slots through natural language,
AI drafts personalised invitations, and invitees accept with capacity enforcement and
intelligent alternatives when a slot is full.

> **Status: in progress** — this README is finalised at submission. See `DESIGN.md` for
> architecture decisions.

## Quick start

```bash
npm run setup     # installs workspaces + creates & seeds the SQLite database
npm run dev       # starts API (:4100) and web (:5173) together
npm test          # both test suites — runs WITHOUT any API key (LLM mocked)
```

To use the live LLM features, copy `server/.env.example` to `server/.env` and set
`ANTHROPIC_API_KEY`.

## Layout

- `server/` — Express + TypeScript + Prisma/SQLite. See `server/README.md`.
- `web/` — Vite + React + TypeScript. See `web/README.md`.
- `shared/` — request/response types shared by both sides.
