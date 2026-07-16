import { useEffect, useRef, useState } from "react";
import type {
  ClarificationQuestion,
  ConfirmResponse,
  DraftedMessage,
  LeadSummary,
  ParseResponse,
  ProposedSlot,
} from "@lette/shared";
import {
  parseSlotRequest,
  confirmSlots,
  draftMessages,
  streamDrafts,
  approveInvitation,
  fetchMe,
  formatSlotTime,
  ApiError,
} from "../api";
import { Avatar, Badge, Button, Card, DateBlock, Shell, TypingDots } from "../components/ui";

// The exchange renders as a lightweight thread — the admin's request, the AI's
// questions, the admin's answers — and the structured preview arrives as the AI's
// final turn, so the confirmation gate reads as the conversation's payoff, not a
// context switch. Underneath, this is NOT a stateful chat: every answer is appended
// to one request string and re-parsed as a stateless single call, so the server sees
// exactly what the thread shows and the whole exchange stays auditable.

const EXAMPLES = [
  "Set up three 30-minute viewings for 22 Maple Street next Tuesday afternoon, max 5 people each, and invite the Johnson and Patel leads",
  "Two viewings at Riverpoint Apartments on Friday morning, 20 minutes each, invite Murphy",
  "Some viewings next week sometime for Botanic View",
];

type Phase = "compose" | "preview" | "created";

/** One turn of the visible exchange. Display-only — the server never sees this shape. */
type ThreadTurn = { role: "admin" | "ai"; text: string };

// The conversation must survive a detour to Slots/Leads and back: the router unmounts
// this page, so an in-progress exchange is snapshotted here (module memory, deliberately
// not storage — a hard refresh starting fresh is correct, losing your thread to a nav
// click is not). Same idea for unapproved draft edits, keyed by slot.
type AdminSession = {
  phase: Phase;
  text: string;
  thread: ThreadTurn[];
  parseText: string;
  normalized: string | null;
  clarifications: ClarificationQuestion[];
  corrections: { from: string; to: string }[];
  parsed: ParseResponse | null;
  created: ConfirmResponse | null;
};
const savedSession: { current: AdminSession | null } = { current: null };
const savedDrafts = new Map<string, { drafts: Record<string, string>; sent: Record<string, string> }>();

/** Test seam (and future logout hook): forget any in-progress exchange. */
export function resetAdminSession() {
  savedSession.current = null;
  savedDrafts.clear();
  greetingPlayed = false;
}

// Vera's greeting types itself out on first visit — the chat idiom this surface borrows.
// Once per session only (a replay on every nav-back would wear thin), instant for
// prefers-reduced-motion, and instant in environments without matchMedia (jsdom/tests).
let greetingPlayed = false;

function useTypedGreeting(fullText: string, ready: boolean): string {
  const [instant] = useState(
    () =>
      greetingPlayed ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [chars, setChars] = useState(instant ? Number.MAX_SAFE_INTEGER : 0);
  useEffect(() => {
    if (!ready || instant) return;
    const id = setInterval(() => {
      setChars((c) => {
        if (c >= fullText.length) {
          clearInterval(id);
          greetingPlayed = true;
          return c;
        }
        return c + 2;
      });
    }, 16);
    return () => clearInterval(id);
  }, [ready, instant, fullText]);
  if (!ready) return "";
  return fullText.slice(0, Math.min(chars, fullText.length));
}

// Clear ways an admin asks to scrap the current draft and begin again. The preview isn't
// created yet, so "start over" / "remove that" / "I don't want it" mean reset the exchange
// — not a scheduling instruction for the parser to puzzle over (and re-propose). Kept
// conservative: "remove the 2pm one" or "drop Priya" are refinements, not resets.
// Note: "cancel" is deliberately NOT a reset verb — "cancel all viewings" is a real
// bulk-cancel of booked viewings, not a draft reset. Reset words are draft-scoped.
const RESET_INTENT = new RegExp(
  [
    "start over",
    "start again",
    "starting over",
    "never ?mind",
    "forget (it|about it|this|that)",
    "\\b(scrap|discard|reset)\\b",
    "get rid of (it|that|this|the (listing|draft|preview|proposal))",
    "(remove|delete|clear|scrap|discard)( the)? (listing|draft|preview|proposal)",
    "(remove|delete|take|clear|get rid of)\\b[^.]*\\bchat\\b", // "remove it from the chat"
    "(remove|delete|scrap|discard)( the| that| this| it)?\\s*$", // "remove that", "delete it"
    "don'?t want (it|this|that|the (listing|draft|proposal|viewings?))",
  ].join("|"),
  "i"
);
export function wantsReset(text: string): boolean {
  return RESET_INTENT.test(text.trim());
}

export default function AdminPage() {
  const saved = savedSession.current;
  const [phase, setPhase] = useState<Phase>(saved?.phase ?? "compose");
  const [text, setText] = useState(saved?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResponse | null>(saved?.parsed ?? null);
  const [created, setCreated] = useState<ConfirmResponse | null>(saved?.created ?? null);
  // The visible conversation. `parseText` is its machine twin: the original request
  // plus every clarification answer, appended — what actually gets parsed. The two
  // always agree; "edit request" collapses the thread back into the composer so the
  // admin can hand-edit the whole exchange.
  const [thread, setThread] = useState<ThreadTurn[]>(saved?.thread ?? []);
  const [parseText, setParseText] = useState(saved?.parseText ?? "");
  // The model's one-sentence restatement of the whole exchange — what "edit the full
  // request" prefills, so hand-editing reads like a sentence, not a Q&A transcript.
  const [normalized, setNormalized] = useState<string | null>(saved?.normalized ?? null);
  // A vague request doesn't navigate anywhere: the AI's question joins the thread and
  // the admin answers it in place — a tap on an option chip or a typed reply. Questions
  // the model marks `multiple` (pick-several, e.g. which leads) turn their chips into
  // toggles collected in `selected` and sent together via the Answer button.
  const [clarifications, setClarifications] = useState<ClarificationQuestion[]>(saved?.clarifications ?? []);
  const [reply, setReply] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [corrections, setCorrections] = useState<{ from: string; to: string }[]>(saved?.corrections ?? []);

  useEffect(() => {
    savedSession.current = { phase, text, thread, parseText, normalized, clarifications, corrections, parsed, created };
  }, [phase, text, thread, parseText, normalized, clarifications, corrections, parsed, created]);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (thread.length === 0) return;
    const el = bottomRef.current;
    // jsdom has no scrollIntoView — guard so tests don't throw.
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [thread, phase, parsed, busy]);
  // First name for Vera's greeting. Best-effort: if the stubbed session endpoint isn't
  // reachable the greeting simply drops the name rather than blocking anything. The
  // typewriter waits for this to settle so it never starts typing the wrong name.
  const [adminName, setAdminName] = useState<string | null>(null);
  const [meSettled, setMeSettled] = useState(false);
  useEffect(() => {
    fetchMe()
      .then((me) => setAdminName(me.admin.name?.split(" ")[0] ?? null))
      .catch(() => {})
      .finally(() => setMeSettled(true));
  }, []);
  // Time-of-day salutation, computed once per mount — a greeting that flips mid-visit
  // would be stranger than one that's a minute stale.
  const [salutation] = useState(() => {
    const hour = new Date().getHours();
    return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  });
  const greetingFull =
    `${salutation}${adminName ? `, ${adminName}` : ""} — I'm Vera. Tell me what viewings you need ` +
    `— property, day, who to invite — and I'll set them up. Nothing is created or sent until you say so.`;
  const greeting = useTypedGreeting(greetingFull, meSettled);

  // `candidate` is the full request text to parse. runParse owns whether it becomes the
  // committed `parseText`: a turn that builds the plan (a question to answer, or actual
  // slots/cancels/moves) commits and advances; a turn that's just conversation — Vera
  // answering "how are you?" or "what's booked?" — shows her reply in the thread but does
  // NOT accumulate. Otherwise every later turn re-answers the chit-chat sitting in the
  // request string, and an aside asked over a preview would blow the preview away.
  async function runParse(candidate: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await parseSlotRequest(candidate);
      if (result.proposal.clarifications.length > 0) {
        setParseText(candidate);
        setNormalized(result.proposal.normalizedRequest ?? null);
        setClarifications(result.proposal.clarifications);
        setCorrections(result.proposal.corrections ?? []);
        setSelected([]);
        setParsed(null);
        setPhase("compose");
        setThread((t) => [
          ...t,
          ...result.proposal.clarifications.map((c): ThreadTurn => ({ role: "ai", text: c.question })),
        ]);
        return; // stay in the exchange
      }
      setClarifications([]);
      setCorrections([]);
      const actions =
        result.proposal.slots.length +
        (result.proposal.cancelSlotIds?.length ?? 0) +
        (result.proposal.reschedules?.length ?? 0) +
        (result.proposal.addInvitees?.length ?? 0);
      if (actions === 0) {
        // Conversational aside: answer it, but don't commit it to the request and don't
        // disturb a preview already on screen. An empty proposal with no reply gets an
        // honest nudge rather than a blank preview.
        setThread((t) => [
          ...t,
          {
            role: "ai",
            text:
              result.proposal.reply?.trim() ||
              "I didn't find anything to schedule in that — tell me the property, the day and who to invite, and I'll set it up.",
          },
        ]);
        return;
      }
      setParseText(candidate);
      setNormalized(result.proposal.normalizedRequest ?? null);
      setParsed(result);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  function startExchange() {
    const query = text.trim();
    setThread([{ role: "admin", text: query }]);
    void runParse(query);
  }

  function applyCorrection(correction: { from: string; to: string }) {
    const escaped = correction.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fixed = parseText.replace(new RegExp(escaped, "i"), correction.to);
    setThread((t) => [...t, { role: "admin", text: correction.to }]);
    void runParse(fixed);
  }

  // The answer becomes the admin's next turn on screen and an appended line in the single
  // request string the server sees — conversational on the surface, stateless underneath.
  // runParse commits the appended text only if it advances the plan.
  function answerClarification(question: string, answer: string) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    if (wantsReset(trimmed)) return reset();
    const base = parseText.trim();
    const next = `${base}\n\nClarification — "${question}": ${trimmed}`;
    setThread((t) => [...t, { role: "admin", text: trimmed }]);
    setReply("");
    setSelected([]);
    void runParse(next);
  }

  // Pushing back on the plan (or just asking Vera something) is a message: it joins the
  // thread and re-parses. runParse decides whether it changed the plan or was an aside.
  function refineRequest(refinement: string) {
    const trimmed = refinement.trim();
    if (!trimmed) return;
    if (wantsReset(trimmed)) return reset();
    const base = parseText.trim();
    const next = base ? `${base}\n\n${trimmed}` : trimmed;
    setThread((t) => [...t, { role: "admin", text: trimmed }]);
    void runParse(next);
  }

  // Collapse the exchange back into the composer for hand-editing. Prefilled with the
  // model's normalized restatement (one clean sentence with every answer folded in)
  // rather than the raw Q&A transcript — the admin reads and edits it here, which is the
  // human gate that lets a model rewrite safely become the new request. Raw text is the
  // fallback when no normalization is available (demo mode, mocks).
  function editRequest() {
    setText(normalized ?? parseText);
    setNormalized(null);
    setThread([]);
    setClarifications([]);
    setCorrections([]);
    setParsed(null);
    setPhase("compose");
  }

  async function handleConfirm() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmSlots({
        slots: parsed.proposal.slots,
        inviteeLeadIds: parsed.proposal.inviteeLeadIds,
        ...(parsed.proposal.cancelSlotIds?.length ? { cancelSlotIds: parsed.proposal.cancelSlotIds } : {}),
        ...(parsed.proposal.reschedules?.length ? { reschedules: parsed.proposal.reschedules } : {}),
        ...(parsed.proposal.addInvitees?.length ? { addInvitees: parsed.proposal.addInvitees } : {}),
      });
      setCreated(result);
      setPhase("created");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("compose");
    setText("");
    setThread([]);
    setParseText("");
    setNormalized(null);
    setParsed(null);
    setCreated(null);
    setError(null);
    setClarifications([]);
    setCorrections([]);
    setReply("");
    setSelected([]);
  }

  return (
    <Shell nav>
      <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        {phase === "compose" && thread.length === 0 && (
          <header className="mb-6">
            <h1 className="sr-only">Create viewings</h1>
            {/* Vera opens the conversation. Composed client-side — the greeting is
                known facts (who you are, what she does), so it costs no model call and
                can never hallucinate. */}
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
                V
              </span>
              <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
                {!meSettled ? (
                  <TypingDots />
                ) : (
                  <p
                    className={`text-[15px] leading-relaxed text-stone-700 ${
                      greeting === greetingFull ? "" : "streaming-caret"
                    }`}
                  >
                    {greeting}
                  </p>
                )}
              </div>
            </div>
          </header>
        )}

        {error && (
          <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {phase === "compose" && thread.length === 0 && (
          <div>
            {/* The prompt box is the product's statement piece: borderless input inside a
                panel, suggestion chips and the submit control embedded within it —
                the AI-native idiom (v0/Claude), not a form field with buttons below. */}
            <div className="rounded-2xl border border-stone-200/80 bg-white shadow-card transition focus-within:border-emerald-700/50 focus-within:shadow-[0_0_0_4px_rgba(10,128,80,0.08),0_16px_40px_rgba(15,23,42,0.08)]">
              <label htmlFor="nl-input" className="sr-only">
                What do you need?
              </label>
              <textarea
                id="nl-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line — the chat idiom this
                  // surface is borrowing from.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!busy && text.trim().length >= 5) startExchange();
                  }
                }}
                rows={3}
                placeholder={`Try "${EXAMPLES[0]}"`}
                className="w-full resize-none bg-transparent p-5 pb-2 text-[16px] leading-relaxed placeholder:text-stone-400 focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                {EXAMPLES.map((example, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setText(example)}
                    className="max-w-full truncate rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-stone-500 transition hover:border-emerald-700/40 hover:text-emerald-800"
                    title={example}
                  >
                    {i === 0 ? "Use example" : i === 1 ? "Friday morning ×2" : "A vague one"}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Preview viewings"
                  onClick={startExchange}
                  disabled={busy || text.trim().length < 5}
                  className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-lg text-white shadow-card transition hover:-translate-y-0.5 hover:bg-emerald-800 hover:shadow-lg active:scale-95 disabled:opacity-40 disabled:hover:translate-y-0"
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        )}

        {thread.length > 0 && (
          <div className="space-y-4">
            {/* Always-available escape hatch: the draft isn't created, so starting over
                just clears the exchange. Sits above the thread so it's never buried. */}
            <div className="flex items-center justify-between border-b border-stone-200/70 pb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-400">
                Conversation
              </span>
              <button
                type="button"
                onClick={reset}
                className="rounded-full px-3 py-1 text-xs font-semibold text-stone-500 transition hover:bg-stone-100 hover:text-stone-800"
              >
                Start over
              </button>
            </div>
            <Thread turns={thread} busy={busy} />

            {phase === "compose" && !busy && (
              <div className="fade-up space-y-2.5 pl-10">
                {(clarifications.find((c) => c.options)?.options || corrections.length > 0) && (
                  <div className="flex flex-wrap gap-2">
                    {clarifications.map((c) =>
                      (c.options ?? []).map((option) =>
                        c.multiple ? (
                          <button
                            key={`${c.question}-${option}`}
                            type="button"
                            aria-pressed={selected.includes(option)}
                            onClick={() =>
                              setSelected((s) =>
                                s.includes(option) ? s.filter((o) => o !== option) : [...s, option]
                              )
                            }
                            className={
                              selected.includes(option)
                                ? "rounded-full border border-emerald-700 bg-emerald-700 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-card transition"
                                : "rounded-full border border-emerald-700/40 bg-emerald-50 px-3.5 py-1.5 text-[13px] font-semibold text-emerald-800 transition hover:bg-emerald-100"
                            }
                          >
                            {selected.includes(option) ? `✓ ${option}` : option}
                          </button>
                        ) : (
                          <button
                            key={`${c.question}-${option}`}
                            type="button"
                            onClick={() => answerClarification(c.question, option)}
                            className="rounded-full border border-emerald-700/40 bg-emerald-50 px-3.5 py-1.5 text-[13px] font-semibold text-emerald-800 transition hover:bg-emerald-100"
                          >
                            {option}
                          </button>
                        )
                      )
                    )}
                    {corrections.map((c) => (
                      <button
                        key={`${c.from}-${c.to}`}
                        type="button"
                        onClick={() => applyCorrection(c)}
                        className="rounded-full border border-emerald-700/40 bg-emerald-50 px-3.5 py-1.5 text-[13px] font-semibold text-emerald-800 transition hover:bg-emerald-100"
                      >
                        Use "{c.to}"
                      </button>
                    ))}
                  </div>
                )}
                <form
                  className="sticky bottom-3 z-20 flex items-center gap-2 rounded-full bg-stone-50/95 p-1 shadow-card backdrop-blur sm:static sm:bg-transparent sm:p-0 sm:shadow-none"
                  onSubmit={(e) => {
                    e.preventDefault();
                    // Toggled chips and any typed text travel as one comma-separated
                    // answer — "Sarah Johnson, Priya Patel" reads like a reply, and the
                    // model handles lists natively.
                    const combined = [...selected, reply.trim()].filter(Boolean).join(", ");
                    if (clarifications.length > 0) {
                      answerClarification(clarifications[0]!.question, combined);
                    } else {
                      // No open question — just the conversation continuing.
                      refineRequest(combined);
                      setReply("");
                    }
                  }}
                >
                  <label htmlFor="clarification-reply" className="sr-only">
                    Your answer
                  </label>
                  <input
                    id="clarification-reply"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={clarifications.length > 0 ? "Type your answer…" : "Reply to Vera…"}
                    className="min-w-0 flex-1 rounded-full border border-stone-200 bg-white px-4 py-2.5 text-sm shadow-card placeholder:text-stone-400 focus:border-emerald-700/50 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={reply.trim().length === 0 && selected.length === 0}
                    className="rounded-full bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-40"
                  >
                    Answer
                  </button>
                </form>
                <button
                  type="button"
                  onClick={editRequest}
                  className="text-xs font-medium text-stone-400 transition hover:text-stone-600"
                >
                  ← Edit the full request instead
                </button>
              </div>
            )}

            {phase === "preview" && parsed && (
              <PreviewPanel
                parsed={parsed}
                busy={busy}
                onBack={editRequest}
                onConfirm={handleConfirm}
                onRefine={refineRequest}
              />
            )}

            {/* Confirmation doesn't navigate anywhere: Vera's "all set" summary and the
                drafting cards are simply the conversation's next turns. */}
            {phase === "created" && created && <CreatedPanel created={created} onReset={reset} />}
            {/* Keeps the newest turn (a preview, a reply) in view instead of buried under
                a growing thread — the listing the admin is acting on shouldn't scroll off. */}
            <div ref={bottomRef} aria-hidden />
          </div>
        )}
      </div>
    </Shell>
  );
}

function Thread(props: { turns: ThreadTurn[]; busy: boolean }) {
  return (
    <div className="space-y-3" aria-label="Conversation">
      {props.turns.map((turn, i) =>
        turn.role === "admin" ? (
          <div key={i} className="fade-up flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-emerald-700 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-card">
              {turn.text}
            </p>
          </div>
        ) : (
          <div key={i} className="fade-up flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
              V
            </span>
            <p className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-2.5 text-[15px] leading-relaxed text-stone-700 shadow-card">
              {turn.text}
            </p>
          </div>
        )
      )}
      {props.busy && (
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
            V
          </span>
          <div className="rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
            <span className="sr-only">Understanding your request…</span>
            <TypingDots />
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewPanel(props: {
  parsed: ParseResponse;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onRefine: (refinement: string) => void;
}) {
  const [tweak, setTweak] = useState("");
  const { proposal, properties, leads } = props.parsed;
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const invitees = proposal.inviteeLeadIds
    .map((id) => leadById.get(id))
    .filter((l): l is LeadSummary => Boolean(l));

  const firstSlot = proposal.slots[0];
  const dayLabel = firstSlot
    ? new Date(`${firstSlot.date}T${firstSlot.startTime}:00`).toLocaleDateString("en-IE", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : null;
  const inviteeFirsts = invitees.map((l) => l.name.split(" ")[0]!);
  const inviteeList =
    inviteeFirsts.length > 1
      ? `${inviteeFirsts.slice(0, -1).join(", ")} and ${inviteeFirsts[inviteeFirsts.length - 1]}`
      : inviteeFirsts[0];
  const existingById = new Map((props.parsed.existingSlots ?? []).map((s) => [s.id, s]));
  const cancels = (proposal.cancelSlotIds ?? [])
    .map((id) => existingById.get(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  const moves = (proposal.reschedules ?? []).map((r) => ({ to: r, from: existingById.get(r.slotId) }));
  const adds = (proposal.addInvitees ?? []).map((a) => ({
    slot: existingById.get(a.slotId),
    leads: a.leadIds.map((id) => leadById.get(id)).filter((l): l is LeadSummary => Boolean(l)),
  }));
  // Vera answers with what she's actually planning — specifics, not a heading. Composed
  // client-side from the proposal (known facts, no model call, nothing to hallucinate).
  const parts: string[] = [];
  if (firstSlot) {
    parts.push(
      `${proposal.slots.length === 1 ? "one viewing" : `${proposal.slots.length} viewings`} at ` +
        `${propertyById.get(firstSlot.propertyId)?.name ?? "the property"} on ${dayLabel}` +
        `${inviteeList ? `, inviting ${inviteeList}` : ""}`
    );
  }
  if (cancels.length > 0) {
    const cancelProps = [...new Set(cancels.map((c) => c.property.name))];
    const where =
      cancelProps.length === 1
        ? `at ${cancelProps[0]}`
        : cancelProps.length === 2
          ? `at ${cancelProps[0]} and ${cancelProps[1]}`
          : `across ${cancelProps.length} properties`;
    parts.push(
      `cancelling ${cancels.length === 1 ? "the viewing" : `${cancels.length} viewings`} ${where}`
    );
  }
  if (moves.length > 0) {
    parts.push(`moving ${moves.length === 1 ? "one viewing" : `${moves.length} viewings`}`);
  }
  if (adds.length > 0) {
    const addNames = [...new Set(adds.flatMap((a) => a.leads.map((l) => l.name.split(" ")[0]!)))];
    const addList =
      addNames.length > 1
        ? `${addNames.slice(0, -1).join(", ")} and ${addNames[addNames.length - 1]}`
        : addNames[0];
    const firstAdd = adds[0]!;
    parts.push(
      `inviting ${addList} to the existing ${
        adds.length === 1 && firstAdd.slot
          ? `viewing at ${firstAdd.slot.property.name} (${formatSlotTime(firstAdd.slot.startsAt)})`
          : `${adds.length} viewings`
      }`
    );
  }
  const opener = parts.length > 0 ? `Got it — ${parts.join(", and ")}.` : "Got it.";
  const totalActions = proposal.slots.length + cancels.length + moves.length + adds.length;

  return (
    <section className="fade-up space-y-4">
      {/* The AI's closing turn, spoken: the plan and its judgement calls are one
          message in its own voice — the structured card below is the evidence. */}
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
          V
        </span>
        <div className="max-w-[85%] space-y-2 rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
          {/* When the latest message was a question about the standing plan, the answer
              comes first — a question must never be swallowed by the preview. */}
          {proposal.reply && (
            <p className="text-[15px] leading-relaxed text-stone-700">{proposal.reply}</p>
          )}
          <p className="text-[15px] leading-relaxed text-stone-700">{opener}</p>
          {proposal.assumptions.length > 0 && (
            <div className="rounded-xl bg-emerald-50/70 px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                How I interpreted this
              </p>
              <p className="mt-1 text-[14px] leading-relaxed text-stone-600">
                {proposal.assumptions.join(" ")}
              </p>
            </div>
          )}
          <p className="text-[15px] leading-relaxed text-stone-700">
            Look right? Nothing's created until you confirm.
          </p>
        </div>
      </div>

      <div className="space-y-4 sm:pl-10">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white/70 px-4 py-2.5">
          <div>
            <p className="text-sm font-semibold text-stone-700">Review the proposed actions</p>
            <p className="text-xs text-stone-500">Nothing below exists until you confirm.</p>
          </div>
          <Badge tone="amber">Draft · not created</Badge>
        </div>
        {[...cancels, ...moves.map((move) => move.from).filter((slot): slot is NonNullable<typeof slot> => Boolean(slot))]
          .some((slot) => slot.acceptedCount > 0) && (
          <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-900">Accepted attendees are affected</p>
            <p className="mt-1 text-sm leading-relaxed text-amber-800">
              Confirming this change will cancel or move a viewing that people have already accepted. They will need to be notified.
            </p>
          </div>
        )}
        {proposal.slots.length > 0 && (
          <Card>
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-stone-700">
                {proposal.slots.length} viewing{proposal.slots.length === 1 ? "" : "s"} to create
              </h2>
              <Badge tone="stone">{propertyById.get(proposal.slots[0]!.propertyId)?.name}</Badge>
            </div>
            <ul className="mt-4 space-y-3">
              {proposal.slots.map((slot, i) => (
                <SlotPreviewRow key={i} slot={slot} propertyName={propertyById.get(slot.propertyId)?.name ?? slot.propertyId} />
              ))}
            </ul>

            <h2 className="mt-6 text-sm font-semibold text-stone-700">Inviting</h2>
            <div className="mt-3 space-y-2">
              {invitees.length === 0 && <p className="text-sm text-stone-400">No one yet</p>}
              {invitees.map((lead) => (
                <div key={lead.id} className="flex items-center gap-3">
                  <Avatar name={lead.name} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{lead.name}</p>
                    {lead.notes && <p className="truncate text-xs text-stone-400">{lead.notes}</p>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {cancels.length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-red-800">
              Cancelling {cancels.length === 1 ? "this viewing" : `${cancels.length} viewings`}
            </h2>
            <ul className="mt-4 space-y-3">
              {cancels.map((slot) => (
                <li key={slot.id} className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <DateBlock iso={slot.startsAt} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold line-through decoration-stone-400">
                      {formatSlotTime(slot.startsAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{slot.property.name}</p>
                  </div>
                  <span className="sm:ml-auto">
                    <Badge tone={slot.acceptedCount > 0 ? "amber" : "stone"}>
                      {slot.acceptedCount > 0
                        ? `${slot.acceptedCount} accepted — they'll need to be told`
                        : "no one accepted yet"}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {moves.length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-stone-700">
              Moving {moves.length === 1 ? "this viewing" : `${moves.length} viewings`}
            </h2>
            <ul className="mt-4 space-y-3">
              {moves.map(({ to, from }) => {
                const newIso = `${to.date}T${to.startTime}:00`;
                return (
                  <li key={to.slotId} className="flex items-start gap-4">
                    <DateBlock iso={newIso} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{formatSlotTime(newIso)}</p>
                      {from && (
                        <p className="mt-0.5 text-xs text-stone-500">
                          was {formatSlotTime(from.startsAt)} · {from.property.name}
                          {from.acceptedCount > 0 ? ` · ${from.acceptedCount} accepted will be notified` : ""}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {adds.length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold text-stone-700">
              Inviting more people to {adds.length === 1 ? "an existing viewing" : `${adds.length} existing viewings`}
            </h2>
            <p className="mt-1 text-xs text-stone-500">
              No new viewings — just invitations. Anyone already invited is skipped.
            </p>
            <ul className="mt-4 space-y-4">
              {adds.map(({ slot, leads: addLeads }, i) => (
                <li key={slot?.id ?? i} className="space-y-2">
                  {slot && (
                    <div className="flex items-center gap-4">
                      <DateBlock iso={slot.startsAt} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">{formatSlotTime(slot.startsAt)}</p>
                        <p className="mt-0.5 text-xs text-stone-500">{slot.property.name}</p>
                      </div>
                      <Badge tone="green">
                        {slot.acceptedCount} of {slot.maxAttendees} accepted
                      </Badge>
                    </div>
                  )}
                  <div className="space-y-2 sm:pl-16">
                    {addLeads.map((lead) => (
                      <div key={lead.id} className="flex items-center gap-3">
                        <Avatar name={lead.name} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{lead.name}</p>
                          {lead.notes && <p className="truncate text-xs text-stone-400">{lead.notes}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Replying to the plan is a message, not a form: changes go back through the
            same parse → preview loop, so the confirmation gate is never bypassed. */}
        <form
          className="sticky bottom-3 z-20 flex items-center gap-2 rounded-full bg-stone-50/95 p-1 shadow-card backdrop-blur sm:static sm:bg-transparent sm:p-0 sm:shadow-none"
          onSubmit={(e) => {
            e.preventDefault();
            props.onRefine(tweak);
            setTweak("");
          }}
        >
          <label htmlFor="preview-refine" className="sr-only">
            Anything to change?
          </label>
          <input
            id="preview-refine"
            value={tweak}
            onChange={(e) => setTweak(e.target.value)}
            placeholder={'Anything to change? Try "make the last one 5pm" or "drop Priya"'}
            className="min-w-0 flex-1 rounded-full border border-stone-200 bg-white px-4 py-2.5 text-sm shadow-card placeholder:text-stone-400 focus:border-emerald-700/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={props.busy || tweak.trim().length === 0}
            className="rounded-full bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-40"
          >
            Update
          </button>
        </form>
        <div className="flex flex-col-reverse items-stretch gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={props.onBack}
            className="text-xs font-medium text-stone-400 transition hover:text-stone-600"
          >
            ← Edit the full request instead
          </button>
          <Button variant="accent" onClick={props.onConfirm} disabled={props.busy || totalActions === 0} className="w-full sm:w-auto">
            {props.busy ? "Working…" : proposal.slots.length > 0 ? "Confirm & create" : "Confirm"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function SlotPreviewRow(props: { slot: ProposedSlot; propertyName: string }) {
  const { slot } = props;
  const iso = `${slot.date}T${slot.startTime}:00`;
  return (
    <li className="flex items-center gap-4">
      <DateBlock iso={iso} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {new Date(iso).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" })}
          <span className="ml-2 font-normal text-stone-500">· {slot.durationMins} min</span>
        </p>
        <p className="mt-0.5 text-xs text-stone-500">{props.propertyName}</p>
      </div>
      <Badge tone="green">max {slot.maxAttendees}</Badge>
    </li>
  );
}

function CreatedPanel(props: { created: ConfirmResponse; onReset: () => void }) {
  const { created } = props;
  const slotCount = created.slots.length;
  const first = created.slots[0];
  const inviteeNames = [...new Set(created.invitations.map((inv) => inv.lead.name.split(" ")[0]!))];
  const nameList =
    inviteeNames.length > 1
      ? `${inviteeNames.slice(0, -1).join(", ")} and ${inviteeNames[inviteeNames.length - 1]}`
      : inviteeNames[0];
  // Vera closes the loop: what was booked, when, and what happens next — composed from
  // the confirm response (known facts, no model call, nothing to hallucinate).
  const donePieces: string[] = [];
  if (first) {
    const times = created.slots.map((slot) => formatSlotTime(slot.startsAt));
    donePieces.push(
      `${slotCount === 1 ? "one viewing" : `${slotCount} viewings`} at ${first.property.name}, ` +
        (slotCount === 1 ? times[0] : `at ${times.join(", ")}`)
    );
  }
  if (created.cancelled?.length) {
    donePieces.push(
      `cancelled ${created.cancelled.length === 1 ? "the viewing" : `${created.cancelled.length} viewings`} at ${created.cancelled[0]!.property.name}`
    );
  }
  if (created.moved?.length) {
    donePieces.push(
      `moved ${created.moved.length === 1 ? "one viewing" : `${created.moved.length} viewings`} — ${created.moved
        .map((m) => `now ${formatSlotTime(m.startsAt)}`)
        .join(", ")}`
    );
  }
  // Existing viewings that got extra invitees. `invitations` holds only what THIS confirm
  // created, so a zero count means everyone named was already invited — say that
  // honestly instead of an "All set" over nothing.
  const invitedTo = (created.invitedTo ?? []).map((slot) => ({
    slot,
    newInvitations: created.invitations.filter((inv) => inv.slotId === slot.id),
  }));
  for (const { slot, newInvitations } of invitedTo) {
    donePieces.push(
      newInvitations.length > 0
        ? `invited ${newInvitations.length === 1 ? "one more person" : `${newInvitations.length} more people`} to the viewing at ${slot.property.name} (${formatSlotTime(slot.startsAt)})`
        : `everyone you named for ${slot.property.name} (${formatSlotTime(slot.startsAt)}) was already invited, so there's nothing new to send there`
    );
  }
  const summary =
    donePieces.length > 0
      ? `All set — ${donePieces.join("; ")}.` +
        (created.invitations.length > 0
          ? ` Next: I'll draft ${inviteeNames.length === 1 ? "an invitation" : "invitations"} for ${nameList} below — you can edit every message, and nothing sends until you approve it.`
          : first
            ? " No invitees yet — you can create more viewings or add people from another request."
            : "")
      : "All set.";
  return (
    <section className="space-y-5">
      <h1 className="sr-only">Viewings created</h1>
      <div className="fade-up flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
          V
        </span>
        <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
          <p className="text-[15px] leading-relaxed text-stone-700">{summary}</p>
        </div>
      </div>
      <div className="space-y-5 sm:pl-10">
        {created.slots.map((slot) => (
          <SlotInvitations
            key={slot.id}
            slotId={slot.id}
            startsAt={slot.startsAt}
            title={slot.property.name}
            subtitle={formatSlotTime(slot.startsAt)}
            invitations={created.invitations.filter((inv) => inv.slotId === slot.id)}
          />
        ))}
        {invitedTo
          .filter(({ newInvitations }) => newInvitations.length > 0)
          .map(({ slot, newInvitations }) => (
            <SlotInvitations
              key={slot.id}
              slotId={slot.id}
              startsAt={slot.startsAt}
              title={slot.property.name}
              subtitle={`${formatSlotTime(slot.startsAt)} · existing viewing`}
              invitations={newInvitations}
            />
          ))}
        <Button variant="ghost" onClick={props.onReset} className="px-0">
          ← Create more viewings
        </Button>
      </div>
    </section>
  );
}

// Drafts are editable text the admin owns — nothing is "sent" until they approve it.
// While a draft streams in it renders read-only with a caret; once complete it becomes
// an editable textarea.
function SlotInvitations(props: {
  slotId: string;
  startsAt: string;
  title: string;
  subtitle: string;
  invitations: ConfirmResponse["invitations"];
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(
    () => savedDrafts.get(props.slotId)?.drafts ?? {}
  );
  const [streaming, setStreaming] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<Record<string, string>>(() => savedDrafts.get(props.slotId)?.sent ?? {});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    savedDrafts.set(props.slotId, { drafts, sent });
  }, [props.slotId, drafts, sent]);

  const invitationByLead = new Map(props.invitations.map((inv) => [inv.lead.id, inv.id]));

  async function handleDraft() {
    setBusy(true);
    setError(null);
    setFailed(new Set());
    const leadIds = props.invitations.map((inv) => inv.lead.id);
    const appendForLead = (leadId: string, text: string) => {
      const invId = invitationByLead.get(leadId);
      if (!invId) return;
      setDrafts((prev) => ({ ...prev, [invId]: (prev[invId] ?? "") + text }));
    };
    const stopStreaming = (leadId: string) => {
      const invId = invitationByLead.get(leadId);
      if (!invId) return;
      setStreaming((prev) => {
        const next = new Set(prev);
        next.delete(invId);
        return next;
      });
    };
    try {
      setDrafts(Object.fromEntries(props.invitations.map((inv) => [inv.id, ""])));
      setStreaming(new Set(props.invitations.map((inv) => inv.id)));
      await streamDrafts({ slotId: props.slotId, leadIds }, (event) => {
        if (event.type === "delta") appendForLead(event.leadId, event.text);
        if (event.type === "done") {
          const invId = invitationByLead.get(event.leadId);
          if (invId) setDrafts((prev) => ({ ...prev, [invId]: event.message }));
          stopStreaming(event.leadId);
        }
        if (event.type === "error") {
          const invId = invitationByLead.get(event.leadId);
          if (invId) setFailed((prev) => new Set(prev).add(invId));
          setError("One or more drafts need attention. Retry them individually or write the message manually.");
          stopStreaming(event.leadId);
        }
      });
    } catch {
      try {
        const result = await draftMessages({ slotId: props.slotId, leadIds });
        const byLead = new Map(result.drafts.map((d: DraftedMessage) => [d.leadId, d.message]));
        setDrafts(
          Object.fromEntries(props.invitations.map((inv) => [inv.id, byLead.get(inv.lead.id) ?? ""]))
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Drafting failed — try again.");
        setDrafts({});
      }
    } finally {
      setStreaming(new Set());
      setBusy(false);
    }
  }

  async function handleRetry(invitationId: string, leadId: string) {
    setBusy(true);
    setError(null);
    setStreaming((prev) => new Set(prev).add(invitationId));
    try {
      const result = await draftMessages({ slotId: props.slotId, leadIds: [leadId] });
      setDrafts((prev) => ({ ...prev, [invitationId]: result.drafts[0]?.message ?? "" }));
      setFailed((prev) => {
        const next = new Set(prev);
        next.delete(invitationId);
        return next;
      });
    } catch (err) {
      setFailed((prev) => new Set(prev).add(invitationId));
      setError(err instanceof ApiError ? err.message : "Retry failed — you can still write this message manually.");
    } finally {
      setStreaming((prev) => {
        const next = new Set(prev);
        next.delete(invitationId);
        return next;
      });
      setBusy(false);
    }
  }

  async function handleApprove(invitationId: string) {
    const message = drafts[invitationId];
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      await approveInvitation(invitationId, message);
      setSent((prev) => ({ ...prev, [invitationId]: new Date().toISOString() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approve failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveAll() {
    const ready = props.invitations.filter((inv) => !sent[inv.id] && (drafts[inv.id]?.trim().length ?? 0) >= 10);
    if (ready.length === 0) return;
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(ready.map((inv) => approveInvitation(inv.id, drafts[inv.id]!)));
    const approvedAt = new Date().toISOString();
    setSent((prev) => ({
      ...prev,
      ...Object.fromEntries(ready.filter((_, i) => results[i]?.status === "fulfilled").map((inv) => [inv.id, approvedAt])),
    }));
    if (results.some((result) => result.status === "rejected")) {
      setError("Some invitations couldn't be approved. The remaining drafts are still here to retry.");
    }
    setBusy(false);
  }

  const hasDrafts = Object.keys(drafts).length > 0;
  const approvedCount = props.invitations.filter((inv) => Boolean(sent[inv.id])).length;
  const readyCount = props.invitations.filter(
    (inv) => !sent[inv.id] && (drafts[inv.id]?.trim().length ?? 0) >= 10 && !streaming.has(inv.id)
  ).length;

  return (
    <Card>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <DateBlock iso={props.startsAt} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          <p className="mt-0.5 text-xs text-stone-500">{props.subtitle}</p>
        </div>
        {!hasDrafts && (
          <Button variant="primary" onClick={handleDraft} disabled={busy || props.invitations.length === 0} className="w-full px-3 py-1.5 text-xs sm:w-auto">
            {busy ? "Drafting…" : "Draft invitations with AI"}
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {hasDrafts && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl bg-stone-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-stone-700">
            {approvedCount} of {props.invitations.length} invitations approved
          </p>
          {readyCount > 1 && (
            <Button variant="primary" onClick={handleApproveAll} disabled={busy} className="w-full px-3 py-1.5 text-xs sm:w-auto">
              {busy ? "Approving…" : `Approve all ${readyCount} ready drafts`}
            </Button>
          )}
        </div>
      )}

      {props.invitations.map((inv) => {
        const isStreaming = streaming.has(inv.id);
        return (
          <div key={inv.id} className="mt-4 border-t border-stone-100 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={inv.lead.name} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {inv.lead.name}
                  {isStreaming && <TypingDots />}
                </p>
                {inv.lead.notes && <p className="truncate text-xs text-stone-400">{inv.lead.notes}</p>}
              </div>
              {sent[inv.id] ? (
                <Badge tone="green">Sent ✓</Badge>
              ) : hasDrafts && !isStreaming ? (
                <div className="flex flex-wrap items-center gap-2">
                  {failed.has(inv.id) && (
                    <Button
                      variant="ghost"
                      onClick={() => handleRetry(inv.id, inv.lead.id)}
                      disabled={busy}
                      className="border border-stone-200 px-3 py-1.5 text-xs"
                    >
                      Retry AI draft
                    </Button>
                  )}
                  <Button
                    variant="accent"
                    onClick={() => handleApprove(inv.id)}
                    disabled={busy || (drafts[inv.id]?.trim().length ?? 0) < 10}
                    className="px-3 py-1.5 text-xs"
                  >
                    Approve & send
                  </Button>
                </div>
              ) : null}
            </div>

            {hasDrafts && !sent[inv.id] && (
              isStreaming ? (
                <p className="streaming-caret mt-3 min-h-16 whitespace-pre-wrap rounded-xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-700">
                  {drafts[inv.id] ?? ""}
                </p>
              ) : (
                <textarea
                  aria-label={`Message for ${inv.lead.name}`}
                  value={drafts[inv.id] ?? ""}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                  rows={6}
                  className="mt-3 min-h-32 w-full resize-none rounded-xl bg-stone-50 p-4 text-[15px] leading-relaxed [field-sizing:content] focus:bg-stone-100/70 focus:outline-none"
                />
              )
            )}

            {sent[inv.id] && (
              <SentInvitationActions invitationId={inv.id} sentAt={sent[inv.id]!} />
            )}
          </div>
        );
      })}
    </Card>
  );
}

function SentInvitationActions(props: { invitationId: string; sentAt: string }) {
  const [copied, setCopied] = useState(false);
  const path = `/invite/${props.invitationId}`;
  const url = `${window.location.origin}${path}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl bg-emerald-50/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-stone-500">
        Sent {new Date(props.sentAt).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={path}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 transition hover:border-emerald-700/40"
        >
          Preview invitation
        </a>
        <button
          type="button"
          onClick={copyLink}
          className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-stone-600 transition hover:border-emerald-700/40 hover:text-emerald-800"
        >
          {copied ? "Link copied ✓" : "Copy invite link"}
        </button>
      </div>
    </div>
  );
}
