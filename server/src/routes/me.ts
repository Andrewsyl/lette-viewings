import { Router } from "express";
import { execSync } from "node:child_process";
import { prisma } from "../lib/db.js";

const router = Router();

// The demo's admin is whoever cloned it: greeting them by their own name beats
// greeting them as a fictional persona. The name comes from local git config — read once,
// never sent anywhere. When git can't provide one, the name is null and the greeting
// simply drops it — a wrong name is worse than no name, so nothing is ever guessed.
// Swap all of this for a real session lookup when auth becomes real.
let cachedGitName: string | null | undefined;
function localGitName(): string | null {
  if (cachedGitName !== undefined) return cachedGitName;
  try {
    cachedGitName =
      execSync("git config user.name", { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null;
  } catch {
    cachedGitName = null;
  }
  return cachedGitName;
}

router.get("/", async (_req, res, next) => {
  try {
    const admin = await prisma.adminUser.findFirstOrThrow();
    res.json({ admin: { id: admin.id, name: localGitName(), email: admin.email } });
  } catch (err) {
    next(err);
  }
});

export default router;
