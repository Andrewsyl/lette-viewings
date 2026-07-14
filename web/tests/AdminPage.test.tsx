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
    await userEvent.click(screen.getByRole("button", { name: /preview slots/i }));

    expect(await screen.findByText(/2 slots to create/i)).toBeInTheDocument();
    expect(screen.getAllByText(/22 Maple Street/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Sarah Johnson")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("asks clarifying questions inline in the composer instead of guessing or navigating", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: { slots: [], inviteeLeadIds: [], clarifications: ["Which day next week?"] },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "some viewings next week sometime");
    await userEvent.click(screen.getByRole("button", { name: /preview slots/i }));

    // The question appears in place…
    expect(await screen.findByText(/Which day next week\?/)).toBeInTheDocument();
    // …the composer (with the admin's text) is still on screen for refining…
    expect(screen.getByLabelText(/what do you need/i)).toHaveValue("some viewings next week sometime");
    // …and no preview/confirm step was entered.
    expect(screen.queryByText(/here's what I understood/i)).not.toBeInTheDocument();
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
            clarifications: ['Did you mean Priya Patel (for "Pryia")?'],
            corrections: [{ from: "Pryia", to: "Priya Patel" }],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots tomorrow, invite Pryia");
    await userEvent.click(screen.getByRole("button", { name: /preview slots/i }));

    await userEvent.click(await screen.findByRole("button", { name: /use "Priya Patel"/i }));

    // The composer text was corrected…
    expect(screen.getByLabelText(/what do you need/i)).toHaveValue("slots tomorrow, invite Priya Patel");
    // …and a second parse was fired with the corrected text.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain("Priya Patel");
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
    await userEvent.click(screen.getByRole("button", { name: /preview slots/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/try rephrasing/i);
  });

  it("confirms the previewed slots and moves to drafting", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": { body: parseResponse },
      "POST /api/slots/confirm": { status: 201, body: confirmResponse },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Maple St");
    await userEvent.click(screen.getByRole("button", { name: /preview slots/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm & create/i }));

    expect(await screen.findByText(/created 1 slot/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /draft invitations with ai/i })).toBeInTheDocument();
  });
});
