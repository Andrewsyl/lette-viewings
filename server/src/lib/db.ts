// env.js must load first: it writes the defaulted DATABASE_URL back into process.env,
// which the Prisma client reads at construction.
import "../env.js";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
