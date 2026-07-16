import { useEffect, useRef, useState } from "react";
import type { ClarificationQuestion, ParseResponse, ConfirmResponse } from "@lette/shared";
import { parseSlotRequest, confirmSlots, fetchMe, ApiError } from "../api";
import { Shell, TypingDots } from "../components/ui";
import { savedSession, clearAdminSession, type Phase, type ThreadTurn } from "./admin/session";
import { useTypedGreeting, resetGreeting } from "./admin/useTypedGreeting";
import { wantsReset } from "./admin/wantsReset";
import { Thread } from "./admin/Thread";
import { PreviewPanel } from "./admin/PreviewPanel";
import { CreatedPanel } from "./admin/CreatedPanel";

// The exchange renders as a lightweight thread — the admin's request, the AI's
// questions, the admin's answers — and the structured preview arrives as the AI's
// final turn, so the confirmation gate reads as the conversation's payoff, not a
// context switch. Underneath, this is NOT a stateful chat: every answer is appended
// to one request string and re-parsed as a stateless single call, so the server sees
// exactly what the thread shows and the whole exchange stays auditable.
//
// This file owns the exchange's state machine (compose → preview → created) and the
// parse/confirm orchestration; the visual panels live in ./admin/, one file each.

const EXAMPLES = [
  "Set up three 30-minute viewings for 17 Sycamore Lane next Tuesday afternoon, max 5 people each, and invite the Kavanagh and Sharma leads",
  "Two viewings at Riverpoint Apartments on Friday morning, 20 minutes each, invite Murphy",
  "Some viewings next week sometime for Botanic View",
];

/** Test seam (and future logout hook): forget any in-progress exchange. */
export function resetAdminSession() {
  clearAdminSession();
  resetGreeting();
}

// Re-exported so tests (and any future consumer) keep one import site for the page.
export { wantsReset };

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
  // Where the preview's local exchange begins. The update bar sits BELOW the plan, so
  // messages typed there must appear below it too — turns from this index render inside
  // the preview section, between the plan and the bar, never up in the scrollback above
  // the cards. Each accepted plan update folds the exchange back into the scrollback.
  const [previewStart, setPreviewStart] = useState(saved?.previewStart ?? saved?.thread.length ?? 0);
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
    savedSession.current = { phase, text, thread, previewStart, parseText, normalized, clarifications, corrections, parsed, created };
  }, [phase, text, thread, previewStart, parseText, normalized, clarifications, corrections, parsed, created]);

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
  // `threadLen` is the thread's length including the turn the caller just appended —
  // when this parse lands a plan, everything before that point is settled scrollback.
  async function runParse(candidate: string, threadLen: number) {
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
      // A new plan settles the exchange so far — refine turns fold into the scrollback
      // above the cards; Vera's refreshed plan bubble is her answer to them.
      setPreviewStart(threadLen);
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
    void runParse(query, 1);
  }

  function applyCorrection(correction: { from: string; to: string }) {
    const escaped = correction.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fixed = parseText.replace(new RegExp(escaped, "i"), correction.to);
    setThread((t) => [...t, { role: "admin", text: correction.to }]);
    void runParse(fixed, thread.length + 1);
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
    void runParse(next, thread.length + 1);
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
    void runParse(next, thread.length + 1);
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
            {/* While a plan is on screen, the exchange since it appeared lives INSIDE the
                preview section (below the cards, where the update bar is) — only settled
                scrollback renders up here, so typing at the bottom never makes words
                appear above the plan. */}
            <Thread
              turns={phase === "preview" ? thread.slice(0, previewStart) : thread}
              busy={busy && phase !== "preview"}
            />

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
                    // answer — "Sarah Kavanagh, Priya Sharma" reads like a reply, and the
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
                turns={thread.slice(previewStart)}
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
