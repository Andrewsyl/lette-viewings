import type { ClarificationQuestion, ConfirmResponse, ParseResponse } from "@lette/shared";

export type Phase = "compose" | "preview" | "created";

/** One turn of the visible exchange. Display-only — the server never sees this shape. */
export type ThreadTurn = { role: "admin" | "ai"; text: string };

// The conversation must survive a detour to Slots/Leads and back: the router unmounts
// this page, so an in-progress exchange is snapshotted here (module memory, deliberately
// not storage — a hard refresh starting fresh is correct, losing your thread to a nav
// click is not). Same idea for unapproved draft edits, keyed by slot.
export type AdminSession = {
  phase: Phase;
  text: string;
  thread: ThreadTurn[];
  previewStart: number;
  parseText: string;
  normalized: string | null;
  clarifications: ClarificationQuestion[];
  corrections: { from: string; to: string }[];
  parsed: ParseResponse | null;
  created: ConfirmResponse | null;
};
export const savedSession: { current: AdminSession | null } = { current: null };
export const savedDrafts = new Map<string, { drafts: Record<string, string>; sent: Record<string, string> }>();

/** Forget any in-progress exchange and unapproved draft edits. */
export function clearAdminSession() {
  savedSession.current = null;
  savedDrafts.clear();
}
