import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { InvitationView, SlotWithCounts } from "@lette/shared";
import { getInvitation, acceptInvitation, acceptAlternative, formatSlotTime, ApiError } from "../api";
import { Button, Card, CapacityDots, DateBlock, Shell } from "../components/ui";

// The invitee's page — the one surface a tenant sees, so it gets consumer-grade
// treatment. Design rule: no dead ends — a full slot shows tappable alternative times,
// never just an error. Accepting twice is safe (the API treats it as a no-op).

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "viewing"; invitation: InvitationView }
  | { kind: "accepted"; slot: SlotWithCounts }
  | { kind: "full"; invitation: InvitationView; alternatives: SlotWithCounts[] };

export default function InvitePage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    getInvitation(id)
      .then((invitation) => {
        if (invitation.status === "ACCEPTED") {
          setState({ kind: "accepted", slot: invitation.slot });
        } else {
          setState({ kind: "viewing", invitation });
        }
      })
      .catch((err) =>
        setState({ kind: "error", message: err instanceof ApiError ? err.message : "Couldn't load this invitation." })
      );
  }, [id]);

  async function handleAccept() {
    if (!id || state.kind !== "viewing") return;
    setBusy(true);
    try {
      const result = await acceptInvitation(id);
      if (result.accepted) {
        setState({ kind: "accepted", slot: result.slot });
      } else {
        setState({ kind: "full", invitation: state.invitation, alternatives: result.alternatives });
      }
    } catch (err) {
      setState({ kind: "error", message: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }

  async function handleTakeAlternative(slotId: string) {
    if (!id) return;
    setBusy(true);
    try {
      const result = await acceptAlternative(id, slotId);
      if (result.accepted) {
        setState({ kind: "accepted", slot: result.slot });
      } else {
        setState((prev) => (prev.kind === "full" ? { ...prev, alternatives: result.alternatives } : prev));
      }
    } catch (err) {
      setState({ kind: "error", message: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-xl px-5 py-12 sm:px-8">
        {state.kind === "loading" && (
          <div className="animate-pulse space-y-3">
            <div className="h-6 w-2/3 rounded bg-stone-200" />
            <div className="h-32 rounded-2xl bg-stone-200" />
            <div className="h-10 w-1/3 rounded-lg bg-stone-200" />
          </div>
        )}

        {state.kind === "error" && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {state.message}
          </div>
        )}

        {state.kind === "viewing" && (
          <ViewingCard invitation={state.invitation} busy={busy} onAccept={handleAccept} />
        )}

        {state.kind === "accepted" && (
          <Card className="border-emerald-200">
            <div className="flex items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-lg text-white">
                ✓
              </span>
              <div>
                <h1 className="text-[22px] font-bold tracking-tight text-emerald-900">You're confirmed</h1>
                <p className="mt-1 text-sm text-stone-500">We've held your spot — see you there.</p>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-4 rounded-xl bg-stone-50 p-4">
              <DateBlock iso={state.slot.startsAt} />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{state.slot.property.name}</p>
                <p className="mt-0.5 text-sm text-stone-500">{state.slot.property.address}</p>
                <p className="mt-1 text-sm font-medium text-emerald-800">{formatSlotTime(state.slot.startsAt)}</p>
              </div>
            </div>
          </Card>
        )}

        {state.kind === "full" && (
          <div className="space-y-4">
            <Card className="border-amber-200 bg-amber-50/60">
              <p className="text-sm text-amber-900">
                That viewing just filled up — but there are other times for{" "}
                <span className="font-semibold">{state.invitation.slot.property.name}</span>:
              </p>
            </Card>
            {state.alternatives.length === 0 ? (
              <p className="text-sm text-stone-500">
                No other times are available right now — the team will be in touch with new viewings soon.
              </p>
            ) : (
              <ul className="space-y-2">
                {state.alternatives.map((slot) => (
                  <li key={slot.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleTakeAlternative(slot.id)}
                      className="flex w-full items-center gap-4 rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-colors hover:border-emerald-700 disabled:opacity-40"
                    >
                      <DateBlock iso={slot.startsAt} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          {new Date(slot.startsAt).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" })}
                        </p>
                        <p className="mt-1">
                          <CapacityDots taken={slot.acceptedCount} max={slot.maxAttendees} />
                        </p>
                      </div>
                      <span className="text-sm font-medium text-emerald-800">Take this →</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

// Message-first: the personalised note IS the invitation — the property details and
// the action support it, not the other way round. The message renders in the same
// bubble language as the admin thread, so the product speaks with one voice.
function ViewingCard(props: { invitation: InvitationView; busy: boolean; onAccept: () => void }) {
  const { invitation } = props;
  return (
    <div className="fade-up space-y-5">
      <header>
        <p className="text-sm font-medium text-emerald-800">You're invited to view</p>
        <h1 className="mt-1 text-[32px] font-bold leading-[1.15] tracking-tight">
          {invitation.slot.property.name}
        </h1>
        <p className="mt-1 text-[15px] text-stone-500">{invitation.slot.property.address}</p>
      </header>

      {invitation.message && (
        <div className="rounded-2xl rounded-tl-md border border-stone-200/80 bg-white px-5 py-4 shadow-card">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-stone-700">{invitation.message}</p>
        </div>
      )}

      <Card className="p-5">
        <div className="flex items-center gap-4">
          <DateBlock iso={invitation.slot.startsAt} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{formatSlotTime(invitation.slot.startsAt)}</p>
            <p className="mt-0.5 text-sm text-stone-500">{invitation.slot.durationMins}-minute viewing</p>
            <p className="mt-2">
              <CapacityDots taken={invitation.slot.acceptedCount} max={invitation.slot.maxAttendees} />
            </p>
          </div>
        </div>
        <Button variant="accent" onClick={props.onAccept} disabled={props.busy} className="mt-5 w-full py-3">
          {props.busy ? "Confirming…" : "Accept invitation"}
        </Button>
        <p className="mt-2.5 text-center text-xs text-stone-400">
          One tap — your spot is held straight away.
        </p>
      </Card>
    </div>
  );
}
