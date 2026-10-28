import { prisma } from "../src/lib/db.js";
import { dublinDateISO } from "../src/lib/parseSlots.js";

// The eval world: the same properties and leads as prisma/seed.ts, so a case that reads
// like a real admin request reads against the roster the real prompt sees. Every trial
// starts from a wiped database — one case's bookings never leak into the next.

export const PROPERTIES = [
  { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Ranelagh, Dublin 6" },
  { id: "prop_quays", name: "Riverpoint Apartments", address: "41 City Quay, Dublin 2" },
  { id: "prop_phibs", name: "9 Botanic View", address: "9 Botanic View, Phibsborough, Dublin 7" },
];

export const LEADS = [
  { id: "lead_kavanagh", name: "Sarah Kavanagh", email: "sarah.kavanagh@example.com", notes: "Couple, relocating from London in August. Asked twice about parking." },
  { id: "lead_sharma", name: "Priya Sharma", email: "priya.sharma@example.com", notes: "Works nearby at the hospital; evenings and weekends only. Has a small dog." },
  { id: "lead_murphy", name: "Conor Murphy", email: "conor.murphy@example.com", notes: "First-time renter, budget-sensitive, very responsive on email." },
  { id: "lead_okafor", name: "Ada Okafor", email: "ada.okafor@example.com", notes: "Postdoc at Trinity, needs a home office space. Available weekday afternoons." },
  { id: "lead_walsh", name: "Emma Walsh", email: "emma.walsh@example.com", notes: "Secondary school teacher, free after 4pm. Cycles everywhere — asked about bike storage." },
  { id: "lead_nowak", name: "Tomasz Nowak", email: "tomasz.nowak@example.com", notes: "Viewing for himself and his brother; prefers mornings before 10am." },
];

/** An existing viewing a case starts with. Ids are fixed so expectations can name them. */
export interface BookedFixture {
  id: string;
  propertyId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  durationMins?: number;
  inviteeLeadIds?: string[];
}

export async function resetWorld(booked: BookedFixture[] = []) {
  await prisma.llmCallLog.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.viewingSlot.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.property.deleteMany();
  await prisma.property.createMany({ data: PROPERTIES });
  await prisma.lead.createMany({ data: LEADS });
  for (const b of booked) {
    await prisma.viewingSlot.create({
      data: {
        id: b.id,
        propertyId: b.propertyId,
        // Naive local time, same construction as the app (see DESIGN.md).
        startsAt: new Date(`${b.date}T${b.startTime}:00`),
        durationMins: b.durationMins ?? 30,
        maxAttendees: 5,
        invitations: { create: (b.inviteeLeadIds ?? []).map((leadId) => ({ leadId })) },
      },
    });
  }
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The FIRST <weekday> in the prompt's CALENDAR (which starts tomorrow) — the reading the
 *  prompt mandates for "Tuesday", "next Tuesday" and "this Tuesday" alike. */
export function nextWeekday(now: Date, weekday: string): string {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase());
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    if (d.getDay() === target) return dublinDateISO(d);
  }
  throw new Error(`unknown weekday ${weekday}`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return dublinDateISO(d);
}
