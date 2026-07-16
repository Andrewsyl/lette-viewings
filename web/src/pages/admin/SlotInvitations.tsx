import { useEffect, useRef, useState } from "react";
import type { ConfirmResponse, DraftedMessage } from "@lette/shared";
import { approveInvitation, draftMessages, streamDrafts, ApiError } from "../../api";
import { Avatar, Badge, Button, Card, DateBlock, TypingDots } from "../../components/ui";
import { savedDrafts } from "./session";

// Drafts are editable text the admin owns — nothing is "sent" until they approve it.
// While a draft streams in it renders read-only with a caret; once complete it becomes
// an editable textarea.
export function SlotInvitations(props: {
  slotId: string;
  startsAt: string;
  title: string;
  /** Optional annotation after the time/day line (e.g. "existing viewing"). */
  subtitle?: string;
  invitations: ConfirmResponse["invitations"];
  /** Reports whether every invitation in this panel has been approved — lets the parent
   *  close the loop once the whole batch is on its way. */
  onAllApproved?: (slotId: string, allApproved: boolean) => void;
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

  const { onAllApproved, slotId, invitations } = props;
  useEffect(() => {
    onAllApproved?.(slotId, invitations.length > 0 && invitations.every((inv) => Boolean(sent[inv.id])));
  }, [onAllApproved, slotId, invitations, sent]);

  const invitationByLead = new Map(props.invitations.map((inv) => [inv.lead.id, inv.id]));

  // --- Display smoothing for streamed drafts ------------------------------------
  // The wire delivers text in multi-word chunks; pasting each one into the draft reads
  // as blocks appearing, not typing. Deltas land in a per-draft buffer and one ticker
  // reveals a few characters at a time, draining faster the further it falls behind —
  // letter-flow when caught up, near-instant catch-up when not, worst case a beat
  // behind the wire. Display pacing only, never fake progress: the moment a draft's
  // buffer drains, its text is set to the server's final message verbatim, and error
  // and fallback paths bypass the buffer entirely.
  type SmoothTarget = { pending: string; final: string | null; onSettled: (() => void) | null };
  const smoothTargets = useRef<Map<string, SmoothTarget>>(new Map());
  const smoothTicker = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTicker = () => {
    if (smoothTicker.current) {
      clearInterval(smoothTicker.current);
      smoothTicker.current = null;
    }
  };
  useEffect(() => stopTicker, []);
  const ensureTicker = () => {
    if (smoothTicker.current) return;
    smoothTicker.current = setInterval(() => {
      if (smoothTargets.current.size === 0) return stopTicker();
      for (const [invId, target] of smoothTargets.current) {
        if (target.pending.length > 0) {
          const take = Math.max(2, Math.ceil(target.pending.length / 6));
          const chunk = target.pending.slice(0, take);
          target.pending = target.pending.slice(take);
          setDrafts((prev) => ({ ...prev, [invId]: (prev[invId] ?? "") + chunk }));
        } else if (target.final !== null) {
          const { final, onSettled } = target;
          smoothTargets.current.delete(invId);
          setDrafts((prev) => ({ ...prev, [invId]: final }));
          onSettled?.();
        }
      }
    }, 28);
  };
  const smoothAppend = (invId: string, text: string) => {
    const target = smoothTargets.current.get(invId) ?? { pending: "", final: null, onSettled: null };
    target.pending += text;
    smoothTargets.current.set(invId, target);
    ensureTicker();
  };
  const smoothSettle = (invId: string, final: string, onSettled: () => void) => {
    const target = smoothTargets.current.get(invId) ?? { pending: "", final: null, onSettled: null };
    target.final = final;
    target.onSettled = onSettled;
    smoothTargets.current.set(invId, target);
    ensureTicker();
  };
  const smoothCancelAll = () => {
    smoothTargets.current.clear();
    stopTicker();
  };

  async function handleDraft() {
    setBusy(true);
    setError(null);
    setFailed(new Set());
    const leadIds = props.invitations.map((inv) => inv.lead.id);
    const stopStreaming = (invId: string) => {
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
        const invId = event.type !== "complete" ? invitationByLead.get(event.leadId) : undefined;
        if (!invId) return;
        if (event.type === "delta") smoothAppend(invId, event.text);
        if (event.type === "done") {
          // The caret keeps blinking until the drain catches up — the draft only
          // becomes editable once every streamed character is on screen.
          smoothSettle(invId, event.message, () => stopStreaming(invId));
        }
        if (event.type === "error") {
          smoothTargets.current.delete(invId);
          setFailed((prev) => new Set(prev).add(invId));
          setError("One or more drafts need attention. Retry them individually or write the message manually.");
          stopStreaming(invId);
        }
      });
    } catch {
      smoothCancelAll();
      setStreaming(new Set());
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

  // The time is the card's most-checked fact (which viewing am I sending invites
  // for?) — it renders bold and dark, never buried in a grey caption. Seen live.
  const starts = new Date(props.startsAt);
  const timeLabel = starts
    .toLocaleTimeString("en-IE", { hour: "numeric", minute: "2-digit", hourCycle: "h12" })
    .replace(/[\s.]/g, "")
    .toLowerCase();
  const dayLabel = starts.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });

  return (
    <Card>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <DateBlock iso={props.startsAt} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          <p className="mt-0.5 text-sm text-stone-600">
            <span className="font-semibold text-stone-900">{timeLabel}</span> · {dayLabel}
            {props.subtitle && <span className="text-stone-400"> · {props.subtitle}</span>}
          </p>
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
              isStreaming && !(drafts[inv.id]?.length) ? (
                // Waiting for the model's first characters — an honest "Vera is
                // thinking" beat instead of an empty box with a blinking caret.
                <div className="mt-3 flex min-h-16 items-center rounded-xl bg-stone-50 p-4">
                  <span className="sr-only">Vera is drafting…</span>
                  <TypingDots />
                </div>
              ) : isStreaming ? (
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
