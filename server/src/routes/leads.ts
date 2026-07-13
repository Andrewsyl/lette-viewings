import { Router } from "express";
import { prisma } from "../lib/db.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { name: "asc" } });
    res.json({ leads });
  } catch (err) {
    next(err);
  }
});

export default router;
