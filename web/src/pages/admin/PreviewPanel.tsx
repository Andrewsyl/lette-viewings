import { useState } from "react";
import type { LeadSummary, ParseResponse, ProposedSlot } from "@lette/shared";
import { formatSlotTime } from "../../api";
import { Avatar, Badge, Button, Card, DateBlock } from "../../components/ui";
import { Thread } from "./Thread";
import type { ThreadTurn } from "./session";

export function PreviewPanel(props: {
  parsed: ParseResponse;
  /** The exchange since this plan appeared — refine messages and Vera's aside answers.
   *  Rendered below the plan, adjacent to the update bar they were typed into. */
  turns: ThreadTurn[];
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

      </div>

      {/* The AI's closing turn, spoken BELOW the evidence it explains and right above the
          update bar it invites a reply into — the plan is a message you can answer, and
          the answer happens where you read it. */}
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

      {/* The exchange since this plan appeared — changes requested, asides answered.
          It belongs to the plan, not the scrollback above it: what's typed into the bar
          below appears here, never above the cards. */}
      {(props.turns.length > 0 || props.busy) && (
        <Thread turns={props.turns} busy={props.busy} label="Discussion of this plan" />
      )}

      <div className="space-y-4 sm:pl-10">
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
