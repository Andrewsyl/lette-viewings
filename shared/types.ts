// API contract shared by server and web. Types only — runtime validation (Zod) lives
// server-side; the client imports these purely for type safety.

export type InvitationStatus = "PENDING" | "ACCEPTED" | "DECLINED";

export interface PropertySummary {
  id: string;
  name: string;
  address: string;
}

export interface LeadSummary {
  id: string;
  name: string;
  email: string;
  notes: string | null;
}

// ---------- NL parse (two-phase create, phase 1: nothing persisted) ----------

export interface ParseRequest {
  text: string;
}

export interface ProposedSlot {
  propertyId: string;
  /** YYYY-MM-DD (Europe/Dublin, naive local time by design — see DESIGN.md) */
  date: string;
  /** HH:MM 24h */
  startTime: string;
  durationMins: number;
  maxAttendees: number;
}

/** A question the admin must answer before anything is created. When the answer set is
 *  small and discrete, `options` lets the UI render one-tap answer chips; `multiple`
 *  marks questions where several options can be picked together (e.g. which leads),
 *  turning the chips into toggles. */
export interface ClarificationQuestion {
  question: string;
  options?: string[];
  multiple?: boolean;
}

/** An existing viewing moved to a new date/time via natural language. */
export interface ProposedReschedule {
  slotId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM 24h */
  startTime: string;
}

export interface SlotProposal {
  slots: ProposedSlot[];
  inviteeLeadIds: string[];
  /** Existing viewings the admin asked to cancel — ids from the grounded booked list. */
  cancelSlotIds?: string[];
  /** Existing viewings the admin asked to move. */
  reschedules?: ProposedReschedule[];
  /** Conversational answer for requests that aren't scheduling instructions ("what's
   *  booked Tuesday?", "can you delete viewings?") — rendered as the AI's turn in the
   *  thread. Only meaningful when the proposal contains no actions or questions. */
  reply?: string;
  /** The whole exchange restated as one clean message the admin could have typed —
   *  every clarification answer and follow-up folded in. Used to prefill "edit the full
   *  request" so hand-editing reads like a sentence, not a Q&A transcript; the admin
   *  reviews it before it becomes the new request, so the model rewrite passes a human
   *  gate. Absent (mocks/demo) ⇒ the UI falls back to the raw exchange text. */
  normalizedRequest?: string;
  /** The start–end range (HH:MM) the admin's words allow ("afternoon" → 13:00–17:00).
   *  The clash repair may move slots freely inside it but never outside — going outside
   *  the window is a question for the admin, not a repair. */
  window?: { earliest: string; latest: string };
  /** Questions the admin must answer when the input was ambiguous. Non-empty ⇒ nothing should be created yet. */
  clarifications: ClarificationQuestion[];
  /** Interpretations the AI made that the admin should be able to check at a glance —
   *  vague words resolved ("afternoon" → from 14:00) and defaults applied. */
  assumptions: string[];
  /** Machine-usable typo fixes accompanying a "did you mean…?" clarification — the UI
   *  renders each as a one-tap correction that rewrites the request and re-parses. */
  corrections?: { from: string; to: string }[];
}

export interface ParseResponse {
  proposal: SlotProposal;
  /** Denormalised previews so the UI can render names, not ids */
  properties: PropertySummary[];
  leads: LeadSummary[];
  /** Current details of any existing viewings referenced by cancelSlotIds/reschedules,
   *  so the preview can show what's about to be cancelled or moved. */
  existingSlots?: SlotWithCounts[];
}

// ---------- Confirm (phase 2: the admin-approved payload is what persists) ----------

export interface ConfirmRequest {
  slots: ProposedSlot[];
  inviteeLeadIds: string[];
  cancelSlotIds?: string[];
  reschedules?: ProposedReschedule[];
}

export interface SlotWithCounts {
  id: string;
  property: PropertySummary;
  startsAt: string; // ISO
  durationMins: number;
  maxAttendees: number;
  acceptedCount: number;
}

export interface ConfirmResponse {
  slots: SlotWithCounts[];
  invitations: InvitationSummary[];
  /** Viewings removed by this confirm (details captured before deletion). */
  cancelled?: SlotWithCounts[];
  /** Viewings moved by this confirm, with their new times. */
  moved?: SlotWithCounts[];
}

// ---------- Invitations ----------

export interface InvitationSummary {
  id: string;
  slotId: string;
  lead: LeadSummary;
  status: InvitationStatus;
  message: string | null;
  approvedAt: string | null;
}

export interface DraftRequest {
  slotId: string;
  leadIds: string[];
}

export interface DraftedMessage {
  leadId: string;
  message: string;
}

export interface DraftResponse {
  drafts: DraftedMessage[];
}

export interface ApproveRequest {
  message: string;
}

/** Invitee-facing view of a single invitation */
export interface InvitationView {
  id: string;
  status: InvitationStatus;
  message: string | null;
  lead: LeadSummary;
  slot: SlotWithCounts;
  spotsRemaining: number;
}

export interface AcceptSuccessResponse {
  accepted: true;
  slot: SlotWithCounts;
  spotsRemaining: number;
}

/** 409 body when the slot is full — alternatives instead of a dead end */
export interface SlotFullResponse {
  accepted: false;
  full: true;
  alternatives: SlotWithCounts[];
}

/** 409 body when the invitation was declined — a decision, not a capacity problem. */
export interface InvitationDeclinedResponse {
  accepted: false;
  declined: true;
  message: string;
}

/** Server-sent events emitted by POST /api/invitations/draft/stream */
export type DraftStreamEvent =
  | { type: "start"; leadId: string }
  | { type: "delta"; leadId: string; text: string }
  | { type: "done"; leadId: string; message: string }
  | { type: "error"; leadId: string; message: string }
  /** `fatal` set = the whole stream died mid-flight (provider failure after headers were
   *  sent, so no HTTP status could carry it) — the client throws and falls back to the
   *  batch draft endpoint. */
  | { type: "complete"; fatal?: string };

/** The stubbed session: who the admin is (used to greet them by name). */
export interface MeResponse {
  /** name is null when the local environment can't provide one (no git identity) —
   *  the greeting drops the name rather than guessing. Never a made-up persona. */
  admin: { id: string; name: string | null; email: string };
}

export interface ApiError {
  message: string;
  details?: unknown;
}
