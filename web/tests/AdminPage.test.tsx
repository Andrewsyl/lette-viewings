import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AdminPage, { wantsReset } from "../src/pages/AdminPage";
import { mockFetchRoutes } from "./setup";
import type { ParseResponse, ConfirmResponse } from "@lette/shared";

const parseResponse: ParseResponse = {
  proposal: {
    slots: [
      { propertyId: "prop_sycamore", date: "2027-01-12", startTime: "14:00", durationMins: 30, maxAttendees: 5 },
      { propertyId: "prop_sycamore", date: "2027-01-12", startTime: "14:30", durationMins: 30, maxAttendees: 5 },
    ],
    inviteeLeadIds: ["lead_kavanagh"],
    clarifications: [],
    assumptions: [],
  },
  properties: [{ id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" }],
  leads: [{ id: "lead_kavanagh", name: "Sarah Kavanagh", email: "sarah@example.com", notes: null }],
};

const confirmResponse: ConfirmResponse = {
  slots: [
    {
      id: "slot_1",
      property: { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" },
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
      lead: { id: "lead_kavanagh", name: "Sarah Kavanagh", email: "sarah@example.com", notes: null },
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

const sycamoreSlot = {
  id: "slot_existing",
  property: { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" },
  startsAt: "2027-01-12T14:00:00.000Z",
  durationMins: 30,
  maxAttendees: 5,
  acceptedCount: 2,
};

/** "Send a few more invites to the 2pm slot" — invitations added to an EXISTING viewing,
 *  no new slots. Regression for a live transcript where the model, having no way to
 *  express this, invented a refusal ("that's done through your property management
 *  system") and the turn died in a 422. */
const addInviteesParse: ParseResponse = {
  proposal: {
    slots: [],
    inviteeLeadIds: [],
    addInvitees: [{ slotId: "slot_existing", leadIds: ["lead_murphy"] }],
    clarifications: [],
    assumptions: [],
  },
  properties: [{ id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" }],
  leads: [{ id: "lead_murphy", name: "Conor Murphy", email: "conor@example.com", notes: null }],
  existingSlots: [sycamoreSlot],
};

const addInviteesConfirm: ConfirmResponse = {
  slots: [],
  invitations: [
    {
      id: "inv_new",
      slotId: "slot_existing",
      lead: { id: "lead_murphy", name: "Conor Murphy", email: "conor@example.com", notes: null },
      status: "PENDING",
      message: null,
      approvedAt: null,
    },
  ],
  invitedTo: [sycamoreSlot],
};

describe("AdminPage", () => {
  it("parses natural language and shows a structured preview before anything is created", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane for Sarah");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    expect(await screen.findByText(/2 viewings to create/i)).toBeInTheDocument();
    expect(screen.getAllByText(/17 Sycamore Lane/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Sarah Kavanagh")).toBeInTheDocument();
    expect(screen.getByText(/draft · not created/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing below exists until you confirm/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("sends the request on Enter (Shift+Enter reserved for newlines)", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane{Enter}");

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
            clarifications: [{ question: 'Did you mean Priya Sharma (for "Pryia")?' }],
            corrections: [{ from: "Pryia", to: "Priya Sharma" }],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots tomorrow, invite Pryia");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    await userEvent.click(await screen.findByRole("button", { name: /use "Priya Sharma"/i }));

    // The correction shows as the admin's turn in the thread…
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
    // …and a second parse was fired with the corrected text.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain("Priya Sharma");
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
                options: ["Sarah Kavanagh", "Priya Sharma", "Conor Murphy"],
                multiple: true,
              },
            ],
            assumptions: [],
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots at Sycamore Lane next Tuesday");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // Chips toggle instead of firing immediately…
    await userEvent.click(await screen.findByRole("button", { name: "Sarah Kavanagh" }));
    await userEvent.click(screen.getByRole("button", { name: "Priya Sharma" }));
    expect(screen.getByRole("button", { name: /✓ Sarah Kavanagh/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));

    // …and travel together as one comma-separated answer.
    const parseCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/nl/parse")
    );
    expect(parseCalls).toHaveLength(2);
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toContain(
      'Clarification — "Who should I invite?": Sarah Kavanagh, Priya Sharma'
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

    await userEvent.type(screen.getByLabelText(/what do you need/i), "slots at Sycamore Lane on Tuesday afternoon");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // Vera answers with the actual plan, not a heading…
    expect(await screen.findByText(/got it — 2 viewings at 17 Sycamore Lane/i)).toBeInTheDocument();
    // …the admin's words stay as the thread's opening turn…
    expect(screen.getByText("slots at Sycamore Lane on Tuesday afternoon")).toBeInTheDocument();
    // …and she speaks her judgement calls in her own voice.
    expect(screen.getByText(/starting at 2pm/)).toBeInTheDocument();
    expect(screen.getByText(/how i interpreted this/i)).toBeInTheDocument();
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

    expect(await screen.findByText(/got it — 2 viewings at 17 Sycamore Lane/i)).toBeInTheDocument();
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

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm & create/i }));

    // Vera closes the loop: what was booked, when, and what happens next.
    expect(await screen.findByText(/all set — one viewing at 17 Sycamore Lane/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing sends until you approve/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /draft invitations with ai/i })).toBeInTheDocument();
  });

  it("shows approval progress and can approve all ready drafts", async () => {
    const secondInvitation = {
      ...confirmResponse.invitations[0]!,
      id: "inv_2",
      lead: { id: "lead_sharma", name: "Priya Sharma", email: "priya@example.com", notes: "Evenings only." },
    };
    const created = { ...confirmResponse, invitations: [...confirmResponse.invitations, secondInvitation] };
    const stream = [
      { type: "done", leadId: "lead_kavanagh", message: "Hi Sarah — here is your reviewed invitation message for Sycamore Lane." },
      { type: "done", leadId: "lead_sharma", message: "Hi Priya — here is your reviewed invitation message for Sycamore Lane." },
      { type: "complete" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return new Response(JSON.stringify({ admin: { id: "a1", name: "Alex", email: "a@x.io" } }));
      if (url === "/api/nl/parse") return new Response(JSON.stringify(parseResponse));
      if (url === "/api/slots/confirm") return new Response(JSON.stringify(created), { status: 201 });
      if (url === "/api/invitations/draft/stream") return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      if (url.endsWith("/approve") && init?.method === "POST") return new Response(JSON.stringify({ ok: true }));
      throw new Error(`Unmocked fetch: ${init?.method ?? "GET"} ${url}`);
    }));
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "two viewings at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm & create/i }));
    await userEvent.click(await screen.findByRole("button", { name: /draft invitations with ai/i }));

    expect(await screen.findByText(/0 of 2 invitations approved/i)).toBeInTheDocument();
    // The drafts settle a beat after the stream ends (the display smoother drains its
    // buffer before a draft becomes editable/approvable) — so wait, don't grab.
    await userEvent.click(await screen.findByRole("button", { name: /approve all 2 ready drafts/i }));
    expect(await screen.findByText(/2 of 2 invitations approved/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sent ✓/i)).toHaveLength(2);
    expect(screen.getAllByText(/preview invitation/i)).toHaveLength(2);
  });

  it("offers a per-lead retry when a streamed draft fails", async () => {
    const stream = [
      { type: "error", leadId: "lead_kavanagh", message: "Couldn't draft this message — try again or write it manually." },
      { type: "complete" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return new Response(JSON.stringify({ admin: { id: "a1", name: "Alex", email: "a@x.io" } }));
      if (url === "/api/nl/parse") return new Response(JSON.stringify(parseResponse));
      if (url === "/api/slots/confirm") return new Response(JSON.stringify(confirmResponse), { status: 201 });
      if (url === "/api/invitations/draft/stream") return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      throw new Error(`Unmocked fetch: ${url}`);
    }));
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "two viewings at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm & create/i }));
    await userEvent.click(await screen.findByRole("button", { name: /draft invitations with ai/i }));

    expect(await screen.findByRole("button", { name: /retry ai draft/i })).toBeInTheDocument();
    expect(screen.getByText(/write the message manually/i)).toBeInTheDocument();
  });

  it("lets the admin reply to the preview with changes instead of editing a form", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane");
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
      "three slots at Sycamore Lane\n\nmake them max 4 people"
    );
    // The gate is never bypassed: the updated plan still ends in a preview to confirm.
    expect(await screen.findByRole("button", { name: /confirm & create/i })).toBeEnabled();
  });

  it("keeps the in-progress exchange when the admin navigates away and back", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    const first = renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    expect(await screen.findByText(/got it — 2 viewings/i)).toBeInTheDocument();

    // Simulate a detour to Slots/Leads: the router unmounts the page entirely…
    first.unmount();
    renderPage();

    // …and the conversation is still there, preview and all.
    expect(screen.getByText("three slots at Sycamore Lane")).toBeInTheDocument();
    expect(screen.getByText(/got it — 2 viewings/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeEnabled();

    // The remounted page fires its /api/me fetch; let it settle inside act so the test
    // doesn't leak a state update past its own end.
    await act(async () => {});
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
            reply: "Yes — just tell me which viewings to cancel, e.g. \"cancel Tuesday's viewings at 17 Sycamore Lane\".",
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
    // The first turn was a pure question (reply, no plan), so it does NOT accumulate into
    // the request — otherwise every later turn re-answers it ("I'm good, thanks!" on top
    // of the actual answer). The follow-up is parsed on its own.
    expect(JSON.parse(parseCalls[1]![1]!.body as string).text).toBe("cancel them all");
  });

  it("does not accumulate conversational asides — each is parsed alone, never re-answered", async () => {
    // The reported bug: three chit-chat turns, and the third ("list tomorrow's viewings")
    // opened with "I'm doing well, thanks!" — re-answering the second. A reply-only turn
    // must not pollute the request string, so every parse sees only the latest line.
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/me")) {
          return new Response(JSON.stringify({ admin: { id: "a1", name: "Alex", email: "a@x.io" } }), { status: 200 });
        }
        const text = JSON.parse(String(init?.body)).text as string;
        bodies.push(text);
        return new Response(
          JSON.stringify({ ...parseResponse, proposal: { slots: [], inviteeLeadIds: [], clarifications: [], assumptions: [], reply: `Reply to: ${text}` } }),
          { status: 200 }
        );
      })
    );
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "what's up with Sonic these days?");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await screen.findByText(/Reply to: what's up with Sonic/i);

    await userEvent.type(screen.getByPlaceholderText(/reply to vera/i), "oh good, how are you?");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));
    await screen.findByText(/Reply to: oh good, how are you\?/i);

    await userEvent.type(screen.getByPlaceholderText(/reply to vera/i), "list tomorrow's viewings");
    await userEvent.click(screen.getByRole("button", { name: /^answer$/i }));
    await screen.findByText(/Reply to: list tomorrow's viewings/i);

    // Every parse saw exactly the line just typed — no accumulation, no re-answering.
    expect(bodies).toEqual([
      "what's up with Sonic these days?",
      "oh good, how are you?",
      "list tomorrow's viewings",
    ]);
  });

  it("keeps the preview intact when the admin asks an aside over it", async () => {
    // Asking Vera a question from the preview (a reply-only turn) must answer in the
    // thread without tearing down the plan the admin is about to confirm.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/me")) {
          return new Response(JSON.stringify({ admin: { id: "a1", name: "Alex", email: "a@x.io" } }), { status: 200 });
        }
        call += 1;
        if (call === 1) return new Response(JSON.stringify(parseResponse), { status: 200 });
        // The aside: reply only.
        return new Response(
          JSON.stringify({ ...parseResponse, proposal: { slots: [], inviteeLeadIds: [], clarifications: [], assumptions: [], reply: "Sarah Kavanagh is a couple relocating from London." } }),
          { status: 200 }
        );
      })
    );
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "two viewings at Sycamore Lane, invite Kavanagh");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    expect(await screen.findByText(/got it — 2 viewings/i)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/anything to change/i), "who's Kavanagh again?");
    await userEvent.click(screen.getByRole("button", { name: /^update$/i }));

    // The answer appears AND the preview + confirm button are still there.
    expect(await screen.findByText(/couple relocating from London/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm & create/i })).toBeInTheDocument();
  });

  it("recognises reset intent but never mistakes a real instruction for one", () => {
    // Discard-the-draft phrasings the admin actually used.
    for (const t of [
      "start over", "lets start over", "never mind", "scrap this", "discard the draft",
      "remove that", "delete it", "remove it from the chat", "get rid of this",
      "I don't want it", "reset", "forget it",
    ]) {
      expect(wantsReset(t)).toBe(true);
    }
    // Real instructions that must NOT be swallowed as a reset — especially the supported
    // bulk cancel, and single-item refinements.
    for (const t of [
      "cancel all viewings", "cancel everything", "cancel Friday's viewings at Riverpoint",
      "drop Priya", "remove the 2pm one", "make the last one 5pm", "invite Kavanagh",
      "two viewings at Sycamore Lane Monday at 2pm",
    ]) {
      expect(wantsReset(t)).toBe(false);
    }
  });

  it("keeps the update-bar exchange below the plan, folding it into the scrollback when the plan updates", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();
    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane for Sarah");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await screen.findByText(/2 viewings to create/i);

    // An aside typed into the bar under the plan must be answered THERE — below the
    // cards, next to where it was typed — never up in the scrollback above the plan.
    // (Live complaint: "when I enter text into that box, the update goes above the card".)
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            slots: [],
            inviteeLeadIds: [],
            clarifications: [],
            assumptions: [],
            reply: "Yes — Sarah is the only invitee so far.",
          },
        },
      },
    });
    await userEvent.type(screen.getByPlaceholderText(/anything to change/i), "is sarah the only one?");
    await userEvent.click(screen.getByRole("button", { name: /^update$/i }));
    const reply = await screen.findByText(/only invitee so far/i);
    const cardsHeading = screen.getByText(/2 viewings to create/i);
    expect(cardsHeading.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A refine that lands a NEW plan settles the exchange: those turns fold into the
    // scrollback above the refreshed cards, where history belongs.
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    await userEvent.type(screen.getByPlaceholderText(/anything to change/i), "make the last one 5pm");
    await userEvent.click(screen.getByRole("button", { name: /^update$/i }));
    await waitFor(() => {
      const refineMsg = screen.getByText("make the last one 5pm");
      const heading = screen.getByText(/2 viewings to create/i);
      expect(refineMsg.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("starts over from the preview when the admin asks to discard the draft", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();
    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    expect(await screen.findByText(/got it — 2 viewings/i)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/anything to change/i), "actually, start over");
    await userEvent.click(screen.getByRole("button", { name: /^update$/i }));

    // Back to the fresh composer — no preview, no thread, no lingering listing.
    expect(screen.getByLabelText(/what do you need/i)).toBeInTheDocument();
    expect(screen.queryByText(/got it — 2 viewings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/17 Sycamore Lane/i)).not.toBeInTheDocument();
  });

  it("the Start over button clears the exchange", async () => {
    mockFetchRoutes({ "POST /api/nl/parse": { body: parseResponse } });
    renderPage();
    await userEvent.type(screen.getByLabelText(/what do you need/i), "three slots at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await screen.findByText(/got it — 2 viewings/i);

    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(screen.getByLabelText(/what do you need/i)).toBeInTheDocument();
    expect(screen.queryByText(/got it — 2 viewings/i)).not.toBeInTheDocument();
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
              property: { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" },
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
            property: { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Dublin 6" },
            startsAt: "2027-01-12T15:00:00.000Z",
            durationMins: 30,
            maxAttendees: 5,
            acceptedCount: 2,
          },
        ] },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "cancel the 3pm viewing at Sycamore Lane");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // The preview says what's being cancelled — including who already accepted.
    expect(await screen.findByText(/got it — cancelling the viewing at 17 Sycamore Lane/i)).toBeInTheDocument();
    expect(screen.getByText(/2 accepted — they'll need to be told/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/accepted attendees are affected/i);

    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    // The op travels in the confirm payload, and Vera closes the loop.
    const confirmCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/slots/confirm")
    );
    expect(JSON.parse(confirmCalls[0]![1]!.body as string).cancelSlotIds).toEqual(["slot_9"]);
    expect(await screen.findByText(/all set — cancelled the viewing at 17 Sycamore Lane/i)).toBeInTheDocument();
  });

  it("previews invitees added to an existing viewing and drafts only the new invitations", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": { body: addInviteesParse },
      "POST /api/slots/confirm": { status: 201, body: addInviteesConfirm },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "send a few more invites to the 2pm slot");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));

    // The preview names the existing viewing and the new invitee — and is explicit that
    // no new viewings are created and nobody gets re-invited.
    expect(await screen.findByText(/got it — inviting Conor to the existing viewing at 17 Sycamore Lane/i)).toBeInTheDocument();
    expect(screen.getByText(/inviting more people to an existing viewing/i)).toBeInTheDocument();
    expect(screen.getByText("Conor Murphy")).toBeInTheDocument();
    expect(screen.getByText(/no new viewings — just invitations/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    // The op travels in the confirm payload…
    const confirmCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes("/api/slots/confirm")
    );
    expect(JSON.parse(confirmCalls[0]![1]!.body as string).addInvitees).toEqual([
      { slotId: "slot_existing", leadIds: ["lead_murphy"] },
    ]);
    // …and the close names the viewing and offers drafting for the NEW invitation only.
    expect(await screen.findByText(/all set — invited one more person to the viewing at 17 Sycamore Lane/i)).toBeInTheDocument();
    expect(screen.getByText(/existing viewing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /draft invitations with ai/i })).toBeEnabled();
  });

  it("prefills 'edit the full request' with the AI's clean restatement, not the Q&A transcript", async () => {
    mockFetchRoutes({
      "POST /api/nl/parse": {
        body: {
          ...parseResponse,
          proposal: {
            ...parseResponse.proposal,
            normalizedRequest: "Two 30-minute viewings at 17 Sycamore Lane on Tuesday 12 January at 2pm, invite Sarah.",
          },
        },
      },
    });
    renderPage();

    await userEvent.type(screen.getByLabelText(/what do you need/i), "some viewings for sycamore lane sometime");
    await userEvent.click(screen.getByRole("button", { name: /preview viewings/i }));
    await screen.findByText(/got it — 2 viewings/i);

    await userEvent.click(screen.getByRole("button", { name: /edit the full request/i }));

    const composer = screen.getByLabelText(/what do you need/i);
    expect(composer).toHaveValue(
      "Two 30-minute viewings at 17 Sycamore Lane on Tuesday 12 January at 2pm, invite Sarah."
    );
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

  it("greets namelessly when no name is available — never guesses one", async () => {
    mockFetchRoutes({
      "GET /api/me": { body: { admin: { id: "a1", name: null, email: "alex@lette-demo.test" } } },
    });
    renderPage();

    expect(
      await screen.findByText(/good (morning|afternoon|evening) — i'm vera/i)
    ).toBeInTheDocument();
  });
});
