import { useCallback, useState } from "react";
import type { ConfirmResponse } from "@lette/shared";
import { formatSlotTime } from "../../api";
import { Button } from "../../components/ui";
import { SlotInvitations } from "./SlotInvitations";
import { useTypewriter } from "./useTypedGreeting";

// Confirm responses whose bubbles have already been spoken — navigating away and back
// restores the panel instantly instead of Vera repeating herself.
const spokenSummaries = new WeakSet<ConfirmResponse>();
const spokenClosings = new WeakSet<ConfirmResponse>();

const timeOf = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString("en-IE", { hour: "numeric", minute: "2-digit", hourCycle: "h12" })
    .replace(/[\s.]/g, "")
    .toLowerCase();
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" });
const listOf = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0]!;

export function CreatedPanel(props: { created: ConfirmResponse; onReset: () => void }) {
  const { created } = props;
  const inviteeNames = [...new Set(created.invitations.map((inv) => inv.lead.name.split(" ")[0]!))];
  const nameList = listOf(inviteeNames);
  // Vera closes the loop: what was booked, when, and what happens next — composed from
  // the confirm response (known facts, no model call, nothing to hallucinate).
  const donePieces: string[] = [];
  if (created.slots.length > 0) {
    // Say the day once and list the times — "Tuesday 21 July at 1:00pm, 1:30pm and
    // 2:00pm", never the full date three times over.
    const groups = new Map<string, { label: string; times: string[] }>();
    for (const slot of created.slots) {
      const key = `${slot.property.name}|${dayOf(slot.startsAt)}`;
      const group = groups.get(key) ?? { label: `at ${slot.property.name} on ${dayOf(slot.startsAt)}`, times: [] };
      group.times.push(timeOf(slot.startsAt));
      groups.set(key, group);
    }
    const described = [...groups.values()]
      .map((g) => `${g.label} at ${listOf(g.times)}`)
      .join(", and ");
    donePieces.push(
      `${created.slots.length === 1 ? "one viewing" : `${created.slots.length} viewings`} ${described}`
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
          : created.slots.length > 0
            ? " No invitees yet — whenever you're ready, just tell me: \"add Sarah to Saturday's viewing\"."
            : "")
      : "All set.";
  // The summary speaks itself like every other Vera turn — the panel arriving fully
  // formed reads as a page swap, not a reply. Pacing of known text, not a fake wait.
  const spoken = useTypewriter(summary, true, !spokenSummaries.has(created), () =>
    spokenSummaries.add(created)
  );

  // A good scheduling experience ENDS somewhere: once every invitation is approved,
  // Vera closes the loop — what went out, and where to watch what happens next —
  // instead of the flow trailing off into a screen of Sent badges.
  const [allSentBySlot, setAllSentBySlot] = useState<Record<string, boolean>>({});
  const handleAllApproved = useCallback((slotId: string, allApproved: boolean) => {
    setAllSentBySlot((prev) =>
      prev[slotId] === allApproved ? prev : { ...prev, [slotId]: allApproved }
    );
  }, []);
  const panelSlotIds = [
    ...created.slots.filter((s) => created.invitations.some((inv) => inv.slotId === s.id)).map((s) => s.id),
    ...invitedTo.filter(({ newInvitations }) => newInvitations.length > 0).map(({ slot }) => slot.id),
  ];
  const allSent = panelSlotIds.length > 0 && panelSlotIds.every((id) => allSentBySlot[id]);
  const closing = `That's everything — ${created.invitations.length === 1 ? "the invitation is" : `all ${created.invitations.length} invitations are`} on their way to ${nameList}. You'll see acceptances on the Viewings page as they come in, and if a time fills up, later invitees get offered the alternatives automatically. Anything else to set up?`;
  const spokenClosing = useTypewriter(closing, allSent, !spokenClosings.has(created), () =>
    spokenClosings.add(created)
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
            invitations={created.invitations.filter((inv) => inv.slotId === slot.id)}
            onAllApproved={handleAllApproved}
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
              subtitle="existing viewing"
              invitations={newInvitations}
              onAllApproved={handleAllApproved}
            />
          ))}
      </div>
      {allSent && (
        <div className="fade-up flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-xs font-extrabold text-white shadow-card">
            V
          </span>
          <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-4 py-3 shadow-card">
            <p className={`text-[15px] leading-relaxed text-stone-700 ${spokenClosing === closing ? "" : "streaming-caret"}`}>
              {spokenClosing}
            </p>
          </div>
        </div>
      )}
      <div className="sm:pl-10">
        <Button variant="ghost" onClick={props.onReset} className="px-0">
          ← Create more viewings
        </Button>
      </div>
    </section>
  );
}
