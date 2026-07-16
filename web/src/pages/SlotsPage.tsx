import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { InvitationSummary, SlotWithCounts } from "@lette/shared";
import { listSlots, listInvitations } from "../api";
import { Avatar, Badge, Card, CapacityDots, Shell } from "../components/ui";

// The operational schedule: date-led, capacity-forward, and detailed enough to answer
// "what is next and who is coming?" without opening each invitation individually.

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; slots: SlotWithCounts[]; invitationsBySlot: Map<string, InvitationSummary[]> };

export default function SlotsPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    Promise.all([listSlots(), listInvitations()])
      .then(([slotsRes, invRes]) => {
        const bySlot = new Map<string, InvitationSummary[]>();
        for (const inv of invRes.invitations) {
          bySlot.set(inv.slotId, [...(bySlot.get(inv.slotId) ?? []), inv]);
        }
        setState({ kind: "loaded", slots: slotsRes.slots, invitationsBySlot: bySlot });
      })
      .catch(() => setState({ kind: "error", message: "Couldn't load the viewing schedule. Try again shortly." }));
  }, []);

  const upcoming = state.kind === "loaded"
    ? state.slots.filter((slot) => new Date(slot.startsAt).getTime() >= Date.now())
    : [];
  const groups = groupByDay(upcoming);
  const allInvitations = state.kind === "loaded"
    ? upcoming.flatMap((slot) => state.invitationsBySlot.get(slot.id) ?? [])
    : [];
  const totalCapacity = upcoming.reduce((sum, slot) => sum + slot.maxAttendees, 0);
  const accepted = upcoming.reduce((sum, slot) => sum + slot.acceptedCount, 0);
  const sent = allInvitations.filter((inv) => Boolean(inv.approvedAt)).length;

  return (
    <Shell nav>
      <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-12">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-800">Schedule</p>
            <h1 className="mt-2 text-[38px] font-bold leading-[1.08] tracking-[-0.04em] sm:text-[46px]">Viewings</h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-stone-500">
              Upcoming appointments, live capacity, and invitation progress in one place.
            </p>
          </div>
          <Link
            to="/admin"
            className="inline-flex w-full items-center justify-center rounded-[14px] bg-emerald-700 px-5 py-3 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-emerald-800 hover:shadow-lg sm:w-auto"
          >
            <span className="mr-2 text-lg leading-none">+</span> New viewing
          </Link>
        </header>

        {state.kind === "loading" && <LoadingSchedule />}

        {state.kind === "error" && (
          <div role="alert" className="mt-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
            {state.message}
          </div>
        )}

        {state.kind === "loaded" && upcoming.length === 0 && <EmptySchedule />}

        {state.kind === "loaded" && upcoming.length > 0 && (
          <>
            <section aria-label="Viewing summary" className="mt-8 grid gap-3 sm:grid-cols-3">
              <MetricCard label="Upcoming" value={String(upcoming.length)} detail={upcoming.length === 1 ? "viewing scheduled" : "viewings scheduled"} />
              <MetricCard label="Seats held" value={`${accepted}/${totalCapacity}`} detail={`${Math.max(totalCapacity - accepted, 0)} places still available`} accent />
              <MetricCard label="Invitations sent" value={String(sent)} detail={`${allInvitations.length - sent} still in draft`} />
            </section>

            <div className="mt-10 space-y-10">
              {groups.map(({ key, date, slots }) => (
                <section key={key} aria-labelledby={`day-${key}`}>
                  <div className="mb-4 flex items-end gap-3 border-b border-stone-200/80 pb-3">
                    <h2 id={`day-${key}`} className="text-xl font-bold tracking-tight text-stone-900">
                      {date.toLocaleDateString("en-IE", { weekday: "long" })}
                    </h2>
                    <p className="pb-0.5 text-sm font-medium text-stone-400">
                      {date.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" })}
                    </p>
                    <span className="ml-auto pb-0.5 text-xs font-semibold text-stone-400">
                      {slots.length} {slots.length === 1 ? "viewing" : "viewings"}
                    </span>
                  </div>
                  <ul className="space-y-3">
                    {slots.map((slot) => (
                      <ViewingRow
                        key={slot.id}
                        slot={slot}
                        invitations={state.invitationsBySlot.get(slot.id) ?? []}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

function ViewingRow(props: { slot: SlotWithCounts; invitations: InvitationSummary[] }) {
  const { slot, invitations } = props;
  const start = new Date(slot.startsAt);
  const acceptedInvites = invitations.filter((inv) => inv.status === "ACCEPTED");
  const pending = invitations.filter((inv) => inv.status === "PENDING" && inv.approvedAt).length;
  const drafts = invitations.filter((inv) => inv.status === "PENDING" && !inv.approvedAt).length;
  const fill = Math.min((slot.acceptedCount / slot.maxAttendees) * 100, 100);

  return (
    <li>
      <Card className="group overflow-hidden p-0 ring-1 ring-stone-200/60 transition hover:-translate-y-0.5 hover:ring-emerald-700/25">
        <div className="flex flex-col lg:flex-row">
          <div className="flex items-center gap-4 border-b border-stone-100 bg-stone-50/70 px-5 py-4 lg:w-40 lg:flex-col lg:items-start lg:justify-center lg:border-b-0 lg:border-r lg:px-6">
            <p className="text-[28px] font-bold leading-none tracking-[-0.04em] text-stone-900">
              {start.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" })}
            </p>
            <p className="text-xs font-semibold text-stone-400">{slot.durationMins} minutes</p>
          </div>

          <div className="min-w-0 flex-1 px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-[17px] font-bold tracking-tight text-stone-900">{slot.property.name}</h3>
                <p className="mt-1 truncate text-sm text-stone-500">{slot.property.address}</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Badge tone={slot.acceptedCount >= slot.maxAttendees ? "amber" : "green"}>
                  {slot.acceptedCount >= slot.maxAttendees ? "Full" : `${slot.maxAttendees - slot.acceptedCount} spaces open`}
                </Badge>
                {pending > 0 && <Badge tone="stone">{pending} awaiting reply</Badge>}
                {drafts > 0 && <Badge tone="stone">{drafts} draft</Badge>}
              </div>
            </div>

            <div className="mt-5">
              <div className="h-1.5 overflow-hidden rounded-full bg-stone-100" aria-hidden="true">
                <div className="h-full rounded-full bg-emerald-700 transition-all" style={{ width: `${fill}%` }} />
              </div>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CapacityDots taken={slot.acceptedCount} max={slot.maxAttendees} />
                {acceptedInvites.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2" aria-label="Accepted attendees">
                    <div className="flex -space-x-2">
                      {acceptedInvites.slice(0, 3).map((inv) => (
                        <span key={inv.id} className="rounded-full bg-white ring-2 ring-white" title={inv.lead.name}>
                          <Avatar name={inv.lead.name} />
                        </span>
                      ))}
                    </div>
                    <span className="text-xs font-medium text-stone-500">
                      {acceptedInvites.slice(0, 2).map((inv) => inv.lead.name.split(" ")[0]).join(", ")}
                      {acceptedInvites.length > 2 ? ` +${acceptedInvites.length - 2}` : ""}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs font-medium text-stone-400">No attendees confirmed yet</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </Card>
    </li>
  );
}

function MetricCard(props: { label: string; value: string; detail: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border px-5 py-4 shadow-[0_6px_20px_rgba(15,23,42,0.04)] ${props.accent ? "border-emerald-200 bg-emerald-50/70" : "border-stone-200/80 bg-white"}`}>
      <p className={`text-xs font-bold uppercase tracking-wider ${props.accent ? "text-emerald-800" : "text-stone-400"}`}>{props.label}</p>
      <p className="mt-2 text-[27px] font-bold leading-none tracking-[-0.04em] text-stone-900">{props.value}</p>
      <p className="mt-2 text-xs text-stone-500">{props.detail}</p>
    </div>
  );
}

function LoadingSchedule() {
  return (
    <div className="mt-8 space-y-8" aria-label="Loading viewing schedule">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="shimmer h-28 rounded-2xl" />
        <div className="shimmer h-28 rounded-2xl" />
        <div className="shimmer h-28 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <div className="shimmer h-5 w-48 rounded" />
        <div className="shimmer h-36 rounded-2xl" />
        <div className="shimmer h-36 rounded-2xl" />
      </div>
    </div>
  );
}

function EmptySchedule() {
  return (
    <Card className="mt-8 overflow-hidden p-0 text-center">
      <div className="px-6 py-12">
        <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Your schedule starts with a sentence</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight">No upcoming viewings</h2>
        <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-stone-500">
          Tell Vera the property, day, and who to invite. She'll turn it into a plan for you to review.
        </p>
        <Link to="/admin" className="mt-6 inline-flex rounded-[14px] bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-emerald-800">
          Describe your first viewing
        </Link>
      </div>
    </Card>
  );
}

function groupByDay(slots: SlotWithCounts[]) {
  const grouped = new Map<string, { date: Date; slots: SlotWithCounts[] }>();
  for (const slot of slots) {
    const date = new Date(slot.startsAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const current = grouped.get(key) ?? { date, slots: [] };
    current.slots.push(slot);
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, value]) => ({ key, ...value }));
}
