import { Router } from "express";
import { prisma } from "../lib/db.js";

const router = Router();

// Stubbed auth per the brief: the seeded admin IS the session. Exists so the UI can
// greet the admin by name — swap for real session lookup when auth becomes real.
router.get("/", async (_req, res, next) => {
  try {
    const admin = await prisma.adminUser.findFirstOrThrow();
    res.json({ admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (err) {
    next(err);
  }
});

export default router;
