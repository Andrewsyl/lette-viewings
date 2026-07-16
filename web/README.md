# Web — Vite + React + TypeScript + Tailwind

## Setup

```bash
# from the repo root:
npm run setup && npm run dev    # web on http://localhost:5173, API proxied to :4100

# or web-only, from this directory:
npm run dev
npm test                        # UI tests (fetch mocked, no server needed)
npm run typecheck
```

## Routes

- `/admin` — the conversational slot creator. Vera (the assistant) greets you by name;
  you describe what you need in plain English and the exchange builds as a light thread:
  her clarifying questions arrive as turns you answer with one-tap option chips
  (toggleable for pick-several questions like "who should I invite?") or a typed reply.
  Her closing turn is the structured preview — slots + invitees + her spoken assumptions —
  which you confirm before anything exists, then draft/edit/approve the AI-written
  invitations. Each sent invitation shows its invite link for the demo. Existing viewings
  are managed the same way — "cancel Tuesday's viewings at Sycamore Lane", "move the 5pm
  to 7pm" — with cancels and moves shown in the preview (including who already accepted)
  before anything is applied.
- `/invite/:id` — the invitee's page: personalised message, live capacity
  ("3 of 5 spots remaining"), accept — and when a slot is full, tappable alternative
  times instead of a dead end.

## Design notes

- A light thread over a stateless parse, not a chat app: the conversation is
  presentation, the text is the state. Every answer is appended to one request string
  and re-parsed as a single stateless call; "edit the full request" collapses the thread
  back into an editable textarea. The **confirmation gate** stays the point — the
  structured preview and drafts review render as full sections, never chat bubbles, and
  clarifying questions block confirmation until answered.
- Plain `fetch` + hooks; no state library — two pages don't justify one.
- Types come from `@lette/shared`, the same contract the server implements.
- API calls go through the Vite dev proxy (`/api` → `:4100`), so there's no base-URL
  config to get wrong.
