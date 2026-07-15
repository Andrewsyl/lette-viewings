import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AdminPage from "../src/pages/AdminPage";
import { mockFetchRoutes } from "./setup";
import type { ParseResponse, ConfirmResponse } from "@lette/shared";

const parseResponse: ParseResponse = {
  proposal: {
    slots: [
      { propertyId: "prop_maple", date: "2027-01-12", startTime: "14:00", durationMins: 30, maxAttendees: 5 },
      { propertyId: "prop_maple", date: "2027-01-12", startTime: "14:30", durationMins: 30, maxAttendees: 5 },
    ],
    inviteeLeadIds: ["lead_johnson"],
    clarifications: [],
    assumptions: [],
  },
  properties: [{ id: "prop_maple", name: "22 Maple Street", address: "22 Maple Street, Dublin 6" }],
  leads: [{ id: "lead_johnson", name: "Sarah Johnson", email: "sarah@example.com", notes: null }],
};

const confirmResponse: ConfirmResponse = {
  slots: [
    {
      id: "slot_1",
      property: { id: "prop_maple", name: "22 Maple Street", address: "22 Maple Street, Dublin 6" },
      startsAt: "2027-01-12T14:00:00.000Z",
      durationMins: 30,
      maxAttendees: 5,
      acceptedCount: 0,
    },
  ],
  invitations: [
    {
      id: "inv_1",
      slotId: "slot_1",
      lead: { id: "lead_johnson", name: "Sarah Johnson", email: "sarah@example.com", notes: null },
      status: "PENDING",
      message: null,
      approvedAt: null,
    },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>
  );
}

describe("AdminPage", () => {
  it("parses natural language and shows a structured preview before anything is created", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St for Sarah");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    expect(await screen.findByText(/2 viewings to create/i)).toBeInTheDocument();
    expect(screen.getAllByText(/22 Maple Street/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Sarah Johnson")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("sends the request on Enter (Shift+Enter reserved for newlines)", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St{Enter}");

    expect(await screen.findByText(/2 viewings to create/i)).toBeInTheDocument();
  });

  it("asks clarifying questions inline in the composer instead of guessing or navigating", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [{ question: "Which day next week?" }],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "some viewings next week sometime");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // The question joins the thread as the AI's turn…
    expect(await screen.findByText(/Which day next week\?/)).toBeInTheDocument();
    // …under the admin's own words…
    expect(screen.getByText("some viewings next week sometime")).toBeInTheDocument();
    // …with a reply box to answer in place, and no preview/confirm step entered.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.queryByText(/got it/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm & create/i })).not.toBeInTheDocument();
  });

  it("renders a did-you-mean correction as a one-tap fix that re-parses", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [{ question: 'Did you mean Priya Patel (for "Pryia")?' }],
            corrections: [{ from: "Pryia", to: "Priya Patel" }],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots tomorrow, invite Pryia");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    await userEvent.click(await screen.findByRole("button", { name: /use "Priya Patel"/i }));

    // The correction shows as the admin's turn in the thread…
    expect(screen.getByText("Priya Patel")).toBeInTheDocument();
    // …and a second parse was fired with the corrected text.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain("Priya Patel");
  });

  it("answers a clarification with one tap when the AI offers options", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [
              { question: "Which day would you like the viewings?", options: ["Monday", "Tuesday"] },
            ],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "some viewings next week sometime");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Tuesday" }));

    // The answer becomes the admin's next turn (chip + thread bubble both say Tuesday)…
    expect(screen.getAllByText("Tuesday").length).toBeGreaterThan(1);
    // …and the second parse carried the bound question+answer to the server.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toBe(
      'some viewings next week sometime\n\nClarification — "Which day would you like the viewings?": Tuesday'
    );
  });

  it("lets the admin pick several options when the question allows it", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [
              {
                question: "Who should I invite?",
                options: ["Sarah Johnson", "Priya Patel", "Conor Murphy"],
                multiple: true,
              },
            ],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots at Maple St next Tuesday");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // Chips toggle instead of firing immediately…
    await userEvent.click(await screen.findByRole("button", { name: "Sarah Johnson" }));
    await userEvent.click(screen.getByRole("button", { name: "Priya Patel" }));
    expect(screen.getByRole("button", { name: /✓ Sarah Johnson/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));

    // …and travel together as one comma-separated answer.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain(
      'Clarification — "Who should I invite?": Sarah Johnson, Priya Patel'
    );
  });

  it("accepts a typed answer to a clarifying question", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [{ question: "Which day next week?" }],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "some viewings next week sometime");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.type(await screen.findByLabelText(/your answer/i), "Friday");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));

    // The typed answer joins the thread as the admin's turn.
    expect(screen.getByText("Friday")).toBeInTheDocument();
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain(
      'Clarification — "Which day next week?": Friday'
    );
  });

  it("shows the admin's request and the AI's assumptions alongside the preview", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            ...parseResponse.proposal,
            assumptions: ['I read "afternoon" as slots starting at 2pm.', "I capped each at 5 people, the default."],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots at Maple St on Tuesday afternoon");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // Vera answers with the actual plan, not a heading…
    expect(await screen.findByText(/got it — 2 viewings at 22 Maple Street/i)).toBeInTheDocument();
    // …the admin's words stay as the thread's opening turn…
    expect(screen.getByText("slots at Maple St on Tuesday afternoon")).toBeInTheDocument();
    // …and she speaks her judgement calls in her own voice.
    expect(screen.getByText(/starting at 2pm/)).toBeInTheDocument();
  });

  it("shows the AI's answer in the preview when a question rode along with the plan", async () => {
    // "wait, will this send 2 invites to the same person?" mid-flow: the plan stands,
    // and the answer must reach the admin, not be swallowed by the preview.
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            ...parseResponse.proposal,
            reply: "Yes — each lead gets one invitation per viewing, so Conor gets two.",
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "two slots, invite Murphy");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    expect(await screen.findByText(/got it — 2 viewings at 22 Maple Street/i)).toBeInTheDocument();
    expect(screen.getByText(/each lead gets one invitation per viewing/i)).toBeInTheDocument();
  });

  it("surfaces the server's message when parsing fails", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        status: 422,
        body: { message: "I couldn't reliably interpret that request — try rephrasing with a specific property, date and time." },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "asdf ghjk");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/try rephrasing/i);
  });

  it("confirms the previewed slots and moves to drafting", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": { body: parseResponse },
      "POST /api/slots/confirm": { status: 201, body: confirmResponse },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm & create/i }));

    // Vera closes the loop: what was booked, when, and what happens next.
    expect(await screen.findByText(/all set — one viewing at 22 Maple Street/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing sends until you approve/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /draft invitations with ai/i })).toBeInTheDocument();
  });

  it("lets the admin reply to the preview with changes instead of editing a form", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await screen.findByText(/got it — 2 viewings/i);

    await userEvent.type(screen.getByLabelText(/anything to change/i), "make them max 4 people");
    await userEvent.click(screen.getByRole("button", { name: /^update$/i }));

    // The refinement becomes the admin's next turn and re-parses the full request.
    expect(await screen.findByText("make them max 4 people")).toBeInTheDocument();
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toBe(
      "three slots at Maple St\n\nmake them max 4 people"
    );
    // The gate is never bypassed: the updated plan still ends in a preview to confirm.
    expect(await screen.findByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("keeps the in-progress exchange when the admin navigates away and back", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    const first = renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    expect(await screen.findByText(/got it — 2 viewings/i)).toBeInTheDocument();

    // Simulate a detour to Slots/Leads: the router unmounts the page entirely…
    first.unmount();
    renderPage();

    // …and the conversation is still there, preview and all.
    expect(screen.getByText("three slots at Maple St")).toBeInTheDocument();
    expect(screen.getByText(/got it — 2 viewings/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("answers questions conversationally instead of showing an empty preview", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [],
            assumptions: [],
            reply: "Yes — just tell me which viewings to cancel, e.g. \"cancel Tuesday's viewings at 22 Maple Street\".",
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "can you delete viewings");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // Vera answers in the thread — no empty "Got it" preview, and the conversation
    // stays open with a reply box.
    expect(await screen.findByText(/just tell me which viewings to cancel/i)).toBeInTheDocument();
    expect(screen.queryByText(/got it/i)).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/reply to vera/i), "cancel them all");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));

    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toBe(
      "can you delete viewings\n\ncancel them all"
    );
  });

  it("previews cancellations and sends them with the confirmed payload", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [],
            assumptions: [],
            cancelSlotIds: ["slot_9"],
          },
          existingSlots: [
            {
              id: "slot_9",
              property: { id: "prop_maple", name: "22 Maple Street", address: "22 Maple Street, Dublin 6" },
              startsAt: "2027-01-12T15:00:00.000Z",
              durationMins: 30,
              maxAttendees: 5,
              acceptedCount: 2,
            },
          ],
        },
      },
      "POST /api/slots/confirm": {
        status: 201,
        body: { slots: [], invitations: [], cancelled: [
          {
            id: "slot_9",
            property: { id: "prop_maple", name: "22 Maple Street", address: "22 Maple Street, Dublin 6" },
            startsAt: "2027-01-12T15:00:00.000Z",
            durationMins: 30,
            maxAttendees: 5,
            acceptedCount: 2,
          },
        ] },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "cancel the 3pm viewing at Maple St");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // The preview says what's being cancelled — including who already accepted.
    expect(await screen.findByText(/got it — cancelling the viewing at 22 Maple Street/i)).toBeInTheDocument();
    expect(screen.getByText(/2 accepted — they'll need to be told/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    // The op travels in the confirm payload, and Vera closes the loop.
    const confirmCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/slots/confirm")
    );
    expect(JSON.parse(confirmCalls[0]![1]!.body as string).cancelSlotIds).toEqual(["slot_9"]);
    expect(await screen.findByText(/all set — cancelled the viewing at 22 Maple Street/i)).toBeInTheDocument();
  });

  it("greets the admin by name, with a time-of-day salutation", async () => {
    mockFetchRoutes({
      "GET /api/me": { body: { admin: { id: "a1", name: "Alex Byrne", email: "alex@lette-demo.test" } } },
    });
    renderPage();

    expect(
      await screen.findByText(/good (morning|afternoon|evening), alex — i'm vera/i)
    ).toBeInTheDocument();
  });
});
