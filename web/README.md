# Web — Vite + React + TypeScript + Tailwind

## Setup

```bash
# from the repo root:
npm run setup && npm run dev    # web on http://localhost:5173, API proxied to :4100

# or web-only, from this directory:
npm run dev
npm test                        # 8 UI tests (fetch mocked, no server needed)
npm run typecheck
```

## Routes

- `/admin` — the conversational slot creator: describe what you need in plain English,
  review the structured preview (slots + invitees + any clarifying questions), confirm,
  then draft/edit/approve the AI-written invitations. Each sent invitation shows its
  invite link for the demo.
- `/invite/:id` — the invitee's page: personalised message, live capacity
  ("3 of 5 spots remaining"), accept — and when a slot is full, tappable alternative
  times instead of a dead end.

## Design notes

- Deliberately a single-shot composer + preview, not a chat: the value is the
  **confirmation gate** — the admin sees exactly what the AI understood before anything
  exists. Clarifying questions render as a banner and block confirmation.
- Plain `fetch` + hooks; no state library — two pages don't justify one.
- Types come from `@lette/shared`, the same contract the server implements.
- API calls go through the Vite dev proxy (`/api` → `:4100`), so there's no base-URL
  config to get wrong.
