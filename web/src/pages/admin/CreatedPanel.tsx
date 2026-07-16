import type { ConfirmResponse } from "@lette/shared";
import { formatSlotTime } from "../../api";
import { Button } from "../../components/ui";
import { SlotInvitations } from "./SlotInvitations";
import { useTypewriter } from "./useTypedGreeting";

// Confirm responses whose summary has already been spoken — navigating away and back
// restores the panel instantly instead of Vera repeating herself.
const spokenSummaries = new WeakSet<ConfirmResponse>();

export function CreatedPanel(props: { created: ConfirmResponse; onReset: () => void }) {
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
            ? " No invitees yet — whenever you're ready, just tell me: \"add Sarah to Saturday's viewing\"."
            : "")
      : "All set.";
  // The summary speaks itself like every other Vera turn — the panel arriving fully
  // formed reads as a page swap, not a reply. Pacing of known text, not a fake wait.
  const spoken = useTypewriter(summary, true, !spokenSummaries.has(created), () =>
    spokenSummaries.add(created)
  );
  return (
    <section className="space-y-5">
      <h1 className="sr-only">Viewings created</h1>
      <div className="fade-up flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
          V
        </span>
        <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
          <p className={`text-[15px] leading-relaxed text-stone-700 ${spoken === summary ? "" : "streaming-caret"}`}>
            {spoken}
          </p>
        </div>
      </div>
      <div className="fade-up space-y-5 sm:pl-10">
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
