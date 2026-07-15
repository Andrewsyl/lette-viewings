import type {
  AcceptSuccessResponse,
  ApproveRequest,
  ConfirmRequest,
  ConfirmResponse,
  DraftRequest,
  DraftResponse,
  DraftStreamEvent,
  InvitationSummary,
  InvitationView,
  LeadSummary,
  MeResponse,
  ParseRequest,
  ParseResponse,
  SlotFullResponse,
  SlotWithCounts,
} from "@lette/shared";

// Thin typed client over fetch. Errors carry the server's message so the UI can show
// something actionable (e.g. the parse 422's "try rephrasing" text) instead of a generic
// failure.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export function fetchMe(): Promise<MeResponse> {
  return request("/api/me");
}

export function parseSlotRequest(text: string): Promise<ParseResponse> {
  const body: ParseRequest = { text };
  return request("/api/nl/parse", { method: "POST", body: JSON.stringify(body) });
}

export function confirmSlots(body: ConfirmRequest): Promise<ConfirmResponse> {
  return request("/api/slots/confirm", { method: "POST", body: JSON.stringify(body) });
}

export function draftMessages(body: DraftRequest): Promise<DraftResponse> {
  return request("/api/invitations/draft", { method: "POST", body: JSON.stringify(body) });
}

export function approveInvitation(id: string, message: string): Promise<{ ok: true }> {
  const body: ApproveRequest = { message };
  return request(`/api/invitations/${id}/approve`, { method: "POST", body: JSON.stringify(body) });
}

export function getInvitation(id: string): Promise<InvitationView> {
  return request(`/api/invitations/${id}`);
}

// Accept can legitimately "fail" with 409 + alternatives — that's a product state, not an
// error, so it's part of the return type rather than a thrown exception.
export async function acceptInvitation(id: string): Promise<AcceptSuccessResponse | SlotFullResponse> {
  const res = await fetch(`/api/invitations/${id}/accept`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (res.ok || res.status === 409) return body;
  throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status);
}

export async function acceptAlternative(
  id: string,
  slotId: string
): Promise<AcceptSuccessResponse | SlotFullResponse> {
  const res = await fetch(`/api/invitations/${id}/accept-alternative`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slotId }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok || res.status === 409) return body;
  throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status);
}

// Streaming drafts: POST + read the SSE body via fetch streams (EventSource can't POST).
// Throws if the stream can't start — callers fall back to the batch draft endpoint.
export async function streamDrafts(
  body: DraftRequest,
  onEvent: (event: DraftStreamEvent) => void
): Promise<void> {
  const res = await fetch("/api/invitations/draft/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new ApiError(`Stream failed (${res.status})`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine.slice(6)) as DraftStreamEvent);
    }
  }
}

export function listSlots(): Promise<{ slots: SlotWithCounts[] }> {
  return request("/api/slots");
}

export function listLeads(): Promise<{ leads: LeadSummary[] }> {
  return request("/api/leads");
}

export function listInvitations(): Promise<{ invitations: InvitationSummary[] }> {
  return request("/api/invitations");
}

export function formatSlotTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
