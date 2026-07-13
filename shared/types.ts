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

export interface SlotProposal {
  slots: ProposedSlot[];
  inviteeLeadIds: string[];
  /** Questions the admin must answer when the input was ambiguous. Non-empty ⇒ nothing should be created yet. */
  clarifications: string[];
}

export interface ParseResponse {
  proposal: SlotProposal;
  /** Denormalised previews so the UI can render names, not ids */
  properties: PropertySummary[];
  leads: LeadSummary[];
}

// ---------- Confirm (phase 2: the admin-approved payload is what persists) ----------

export interface ConfirmRequest {
  slots: ProposedSlot[];
  inviteeLeadIds: string[];
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

export interface ApiError {
  message: string;
  details?: unknown;
}
