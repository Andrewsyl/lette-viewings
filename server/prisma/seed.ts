import { prisma } from "../src/lib/db.js";

// Seed data matches the README's example prompt (17 Sycamore Lane, the Kavanagh and
// Sharma leads) so it works verbatim on first run.
async function main() {
  await prisma.invitation.deleteMany();
  await prisma.viewingSlot.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.property.deleteMany();
  await prisma.adminUser.deleteMany();

  await prisma.adminUser.create({
    data: { name: "Alex Byrne", email: "alex@lette-demo.test" },
  });

  await prisma.property.createMany({
    data: [
      { id: "prop_sycamore", name: "17 Sycamore Lane", address: "17 Sycamore Lane, Ranelagh, Dublin 6" },
      { id: "prop_quays", name: "Riverpoint Apartments", address: "41 City Quay, Dublin 2" },
      { id: "prop_phibs", name: "9 Botanic View", address: "9 Botanic View, Phibsborough, Dublin 7" },
    ],
  });

  await prisma.lead.createMany({
    data: [
      {
        id: "lead_kavanagh",
        name: "Sarah Kavanagh",
        email: "sarah.kavanagh@example.com",
        notes: "Couple, relocating from London in August. Asked twice about parking.",
      },
      {
        id: "lead_sharma",
        name: "Priya Sharma",
        email: "priya.sharma@example.com",
        notes: "Works nearby at the hospital; evenings and weekends only. Has a small dog.",
      },
      {
        id: "lead_murphy",
        name: "Conor Murphy",
        email: "conor.murphy@example.com",
        notes: "First-time renter, budget-sensitive, very responsive on email.",
      },
      {
        id: "lead_okafor",
        name: "Ada Okafor",
        email: "ada.okafor@example.com",
        notes: "Postdoc at Trinity, needs a home office space. Available weekday afternoons.",
      },
      {
        id: "lead_walsh",
        name: "Emma Walsh",
        email: "emma.walsh@example.com",
        notes: "Secondary school teacher, free after 4pm. Cycles everywhere — asked about bike storage.",
      },
      {
        id: "lead_nowak",
        name: "Tomasz Nowak",
        email: "tomasz.nowak@example.com",
        notes: "Viewing for himself and his brother; prefers mornings before 10am.",
      },
    ],
  });

  console.log("Seeded: 1 admin, 3 properties, 6 leads");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
