import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import InvitePage from "../src/pages/InvitePage";
import { mockFetchRoutes } from "./setup";
import type { InvitationView, SlotWithCounts } from "@lette/shared";

const slot: SlotWithCounts = {
  id: "slot_1",
  property: { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" },
  startsAt: "2027-01-12T14:00:00.000Z",
  durationMins: 30,
  maxAttendees: 5,
  acceptedCount: 2,
};

const invitation: InvitationView = {
  id: "inv_1",
  status: "PENDING",
  message: "Hi Sarah — we'd love to show you 17 Sycamore Lane.",
  lead: { id: "lead_kavanagh", name: "Sarah Kavanagh", email: "sarah@example.com", notes: null },
  slot,
  spotsRemaining: 3,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/invite/inv_1"]}>
      <Routes>
        <Route path="/invite/:id" element={<InvitePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("InvitePage", () => {
  it("shows the personalised message and live capacity", async () => {
    mockFetchRoutes({ "GET /api/invitations/inv_1": { body: invitation } });
    renderPage();

    expect(await screen.findByText(/Hi Sarah/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 5 spots remaining/)).toBeInTheDocument();
  });

  it("accepts and confirms", async () => {
    mockFetchRoutes({
      "GET /api/invitations/inv_1": { body: invitation },
      "POST /api/invitations/inv_1/accept": {
        body: { accepted: true, slot: { ...slot, acceptedCount: 3 }, spotsRemaining: 2 },
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /accept invitation/i }));
    expect(await screen.findByText(/you're confirmed/i)).toBeInTheDocument();
  });

  it("shows tappable alternatives instead of a dead end when the slot is full", async () => {
    const alternative: SlotWithCounts = { ...slot, id: "slot_2", startsAt: "2027-01-14T15:00:00.000Z", acceptedCount: 0 };
    mockFetchRoutes({
      "GET /api/invitations/inv_1": { body: invitation },
      "POST /api/invitations/inv_1/accept": {
        status: 409,
        body: { accepted: false, full: true, alternatives: [alternative] },
      },
      "POST /api/invitations/inv_1/accept-alternative": {
        body: { accepted: true, slot: { ...alternative, acceptedCount: 1 }, spotsRemaining: 4 },
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /accept invitation/i }));
    expect(await screen.findByText(/viewing is full/i)).toBeInTheDocument();

    await userEvent.click(screen.getByText(/5 of 5 spots remaining/i));
    expect(await screen.findByText(/you're confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/original invitation has been replaced/i)).toBeInTheDocument();
  });

  it("does not offer acceptance when the invitation loads with no capacity", async () => {
    mockFetchRoutes({
      "GET /api/invitations/inv_1": {
        body: { ...invitation, slot: { ...slot, acceptedCount: 5 }, spotsRemaining: 0 },
      },
    });
    renderPage();

    expect(await screen.findByRole("button", { name: /see alternative times/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^accept invitation$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/won't be booked until you choose/i)).toBeInTheDocument();
  });

  it("shows an already-accepted invitation as confirmed on load", async () => {
    mockFetchRoutes({
      "GET /api/invitations/inv_1": { body: { ...invitation, status: "ACCEPTED" } },
    });
    renderPage();

    expect(await screen.findByText(/you're confirmed/i)).toBeInTheDocument();
  });
});
