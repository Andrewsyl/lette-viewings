import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { InvitationSummary, SlotWithCounts } from "@lette/shared";
import { listSlots, listInvitations, formatSlotTime } from "../api";
import { Badge, Card, CapacityDots, DateBlock, Shell } from "../components/ui";

// The ops view: every upcoming slot with its capacity and invitation states — the page
// that makes this feel like a product you live in rather than a one-shot wizard.

type State =
  | { kind: "loading" }
  | { kind: "loaded"; slots: SlotWithCounts[]; invitationsBySlot: Map<string, InvitationSummary[]> };

export default function SlotsPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    Promise.all([listSlots(), listInvitations()]).then(([slotsRes, invRes]) => {
      const bySlot = new Map<string, InvitationSummary[]>();
      for (const inv of invRes.invitations) {
        bySlot.set(inv.slotId, [...(bySlot.get(inv.slotId) ?? []), inv]);
      }
      setState({ kind: "loaded", slots: slotsRes.slots, invitationsBySlot: bySlot });
    });
  }, []);

  return (
    <Shell nav>
      <div className="px-5 py-12 sm:px-8">
        <header className="mb-8">
          <h1 className="text-[36px] font-bold leading-[1.15] tracking-tight">Viewings</h1>
          <p className="mt-2 text-[16px] text-stone-500">Every upcoming viewing, its capacity, and who's coming.</p>
        </header>

        {state.kind === "loading" && (
          <div className="space-y-3">
            <div className="shimmer h-20 rounded-2xl" />
            <div className="shimmer h-20 rounded-2xl" />
          </div>
        )}

        {state.kind === "loaded" && state.slots.length === 0 && (
          <Card className="text-center">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Your schedule starts with a sentence</p>
            <h2 className="mt-2 text-xl font-bold tracking-tight">No viewings yet</h2>
            <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-stone-500">
              Tell Vera the property, day, and who to invite. She'll turn it into a plan for you to review.
            </p>
            <Link
              to="/admin"
              className="mt-5 inline-flex rounded-[14px] bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-emerald-800"
            >
              Describe your first viewing
            </Link>
          </Card>
        )}

        {state.kind === "loaded" && state.slots.length > 0 && (
          <ul className="space-y-3">
            {state.slots.map((slot) => {
              const invitations = state.invitationsBySlot.get(slot.id) ?? [];
              const pending = invitations.filter((i) => i.status === "PENDING").length;
              return (
                <li key={slot.id}>
                  <Card className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:gap-5">
                    <DateBlock iso={slot.startsAt} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-semibold">
                        {slot.property.name}
                        <span className="ml-2 font-normal text-stone-500">· {formatSlotTime(slot.startsAt)}</span>
                      </p>
                      <p className="mt-1.5">
                        <CapacityDots taken={slot.acceptedCount} max={slot.maxAttendees} />
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5 sm:ml-auto sm:flex-col sm:items-end">
                      <Badge tone="green">{slot.acceptedCount} accepted</Badge>
                      {pending > 0 && <Badge tone="stone">{pending} pending</Badge>}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Shell>
  );
}
