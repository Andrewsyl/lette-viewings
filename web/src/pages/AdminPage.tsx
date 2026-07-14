import { useState } from "react";
import type {
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
  formatSlotTime,
  ApiError,
} from "../api";
import { Avatar, Badge, Button, Card, DateBlock, Shell, SkeletonPreview, Steps, TypingDots } from "../components/ui";

// Deliberately a single-shot composer + structured preview, not a chat: the point of the
// feature is the confirmation gate — the admin sees exactly what the AI understood
// before anything is created. Clarifications render as a question the admin answers by
// refining their request.

const EXAMPLES = [
  "Set up three 30-minute viewing slots for 22 Maple Street next Tuesday afternoon, max 5 people each, and invite the Johnson and Patel leads",
  "Two viewings at Riverpoint Apartments on Friday morning, 20 minutes each, invite Murphy",
  "Some viewings next week sometime for Botanic View",
];

type Phase = "compose" | "preview" | "created";

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>("compose");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [created, setCreated] = useState<ConfirmResponse | null>(null);
  // A vague request doesn't navigate anywhere: the AI's question appears inline under
  // the composer and the admin refines their sentence in place. Conversational repair
  // without the ceremony of a chat UI.
  const [clarifications, setClarifications] = useState<string[]>([]);
  // Machine-usable typo fixes riding with a "did you mean…?" — each renders as a
  // one-tap chip that rewrites the request and re-parses.
  const [corrections, setCorrections] = useState<{ from: string; to: string }[]>([]);

  async function handleParse(nextText?: string) {
    const query = nextText ?? text;
    setBusy(true);
    setError(null);
    try {
      const result = await parseSlotRequest(query);
      if (result.proposal.clarifications.length > 0) {
        setClarifications(result.proposal.clarifications);
        setCorrections(result.proposal.corrections ?? []);
        return; // stay in the composer
      }
      setClarifications([]);
      setCorrections([]);
      setParsed(result);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  function applyCorrection(correction: { from: string; to: string }) {
    const escaped = correction.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fixed = text.replace(new RegExp(escaped, "i"), correction.to);
    setText(fixed);
    void handleParse(fixed);
  }

  async function handleConfirm() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmSlots({
        slots: parsed.proposal.slots,
        inviteeLeadIds: parsed.proposal.inviteeLeadIds,
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
    setParsed(null);
    setCreated(null);
    setError(null);
  }

  return (
    <Shell nav>
      <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        <Steps current={phase === "compose" ? 0 : phase === "preview" ? 1 : 2} />
        {phase === "compose" && (
          <header className="mb-8">
            <h1 className="text-[36px] font-bold leading-[1.15] tracking-tight">Describe the viewings you need</h1>
            <p className="mt-2 text-[16px] leading-relaxed text-stone-500">
              Plain English is the whole form — property, day, times, who to invite.
              You'll review everything before anything is created or sent.
            </p>
          </header>
        )}

        {error && (
          <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {phase === "compose" && (
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
                  aria-label="Preview slots"
                  onClick={() => handleParse()}
                  disabled={busy || text.trim().length < 5}
                  className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-lg text-white shadow-card transition hover:-translate-y-0.5 hover:bg-emerald-800 hover:shadow-lg active:scale-95 disabled:opacity-40 disabled:hover:translate-y-0"
                >
                  ↑
                </button>
              </div>
              {busy && (
                <div className="border-t border-stone-100 px-5 py-5">
                  <SkeletonPreview />
                </div>
              )}
              {!busy && clarifications.length > 0 && (
                <div className="fade-up flex items-start gap-3 border-t border-stone-100 px-5 py-5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
                    V
                  </span>
                  <div className="min-w-0">
                    {clarifications.map((q) => (
                      <p key={q} className="text-[15px] leading-relaxed text-stone-700">
                        {q}
                      </p>
                    ))}
                    {corrections.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-2">
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
                    <p className="mt-2 text-xs text-stone-400">
                      {corrections.length > 0
                        ? "Tap to fix it, or edit your request above."
                        : "Add the detail to your request above and preview again — I'd rather ask than guess."}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "preview" && parsed && (
          <PreviewPanel parsed={parsed} busy={busy} onBack={() => setPhase("compose")} onConfirm={handleConfirm} />
        )}

        {phase === "created" && created && <CreatedPanel created={created} onReset={reset} />}
      </div>
    </Shell>
  );
}

function PreviewPanel(props: {
  parsed: ParseResponse;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { proposal, properties, leads } = props.parsed;
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const invitees = proposal.inviteeLeadIds
    .map((id) => leadById.get(id))
    .filter((l): l is LeadSummary => Boolean(l));

  return (
    <section className="fade-up space-y-5">
      <header>
        <h1 className="text-[36px] font-bold leading-[1.15] tracking-tight">Here's what I understood</h1>
        <p className="mt-2 text-[16px] text-stone-500">Nothing exists yet — check it, then confirm.</p>
      </header>

      {proposal.slots.length > 0 && (
        <Card>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-stone-700">
              {proposal.slots.length} slot{proposal.slots.length === 1 ? "" : "s"} to create
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

      <div className="flex items-center justify-between pt-1">
        <Button variant="ghost" onClick={props.onBack} className="px-0">
          ← Edit request
        </Button>
        <Button variant="accent" onClick={props.onConfirm} disabled={props.busy || proposal.slots.length === 0}>
          {props.busy ? "Creating…" : "Confirm & create"}
        </Button>
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
  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-[36px] font-bold leading-[1.15] tracking-tight">
          Created {created.slots.length} slot{created.slots.length === 1 ? "" : "s"} ✓
        </h1>
        <p className="mt-2 text-[16px] text-stone-500">
          {created.invitations.length} invitation{created.invitations.length === 1 ? "" : "s"} ready — draft the
          messages, tweak anything, then send.
        </p>
      </header>
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
      <Button variant="ghost" onClick={props.onReset} className="px-0">
        ← Create more slots
      </Button>
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invitationByLead = new Map(props.invitations.map((inv) => [inv.lead.id, inv.id]));

  async function handleDraft() {
    setBusy(true);
    setError(null);
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
          setError(event.message);
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

  async function handleApprove(invitationId: string) {
    const message = drafts[invitationId];
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      await approveInvitation(invitationId, message);
      setSent((prev) => ({ ...prev, [invitationId]: true }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approve failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  const hasDrafts = Object.keys(drafts).length > 0;

  return (
    <Card>
      <div className="flex items-center gap-4">
        <DateBlock iso={props.startsAt} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          <p className="mt-0.5 text-xs text-stone-500">{props.subtitle}</p>
        </div>
        {!hasDrafts && (
          <Button variant="primary" onClick={handleDraft} disabled={busy || props.invitations.length === 0} className="px-3 py-1.5 text-xs">
            {busy ? "Drafting…" : "Draft invitations with AI"}
          </Button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {props.invitations.map((inv) => {
        const isStreaming = streaming.has(inv.id);
        return (
          <div key={inv.id} className="mt-4 border-t border-stone-100 pt-4">
            <div className="flex items-center gap-3">
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
                <Button
                  variant="accent"
                  onClick={() => handleApprove(inv.id)}
                  disabled={busy || !drafts[inv.id]}
                  className="px-3 py-1.5 text-xs"
                >
                  Approve & send
                </Button>
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
              <p className="mt-2 text-xs text-stone-500">
                Invite link:{" "}
                <a href={`/invite/${inv.id}`} className="font-medium text-emerald-800 underline underline-offset-2">
                  {window.location.origin}/invite/{inv.id}
                </a>
              </p>
            )}
          </div>
        );
      })}
    </Card>
  );
}
