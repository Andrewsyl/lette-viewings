import { Router } from "express";
import { z } from "zod";
import { parseSlotRequest } from "../lib/parseSlots.js";
import type { ParseResponse } from "@lette/shared";

const router = Router();

const parseBody = z.object({ text: z.string().min(5).max(2000) });

// Phase 1 of the two-phase create: returns a structured proposal for admin review.
// Persists nothing except the LLM audit log entry.
router.post("/parse", async (req, res, next) => {
  try {
    const { text } = parseBody.parse(req.body);
    const result = await parseSlotRequest(text);
    const response: ParseResponse = {
      proposal: result.proposal,
      properties: result.properties,
      leads: result.leads,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
