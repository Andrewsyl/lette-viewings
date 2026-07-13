import express from "express";
import cors from "cors";
import { ZodError } from "zod";
import nlRouter from "./routes/nl.js";
import slotsRouter from "./routes/slots.js";
import invitationsRouter from "./routes/invitations.js";
import leadsRouter from "./routes/leads.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/nl", nlRouter);
  app.use("/api/slots", slotsRouter);
  app.use("/api/invitations", invitationsRouter);
  app.use("/api/leads", leadsRouter);

  // Central error handler: routes `next(err)`, this maps the taxonomy to HTTP.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(422).json({ message: "Invalid request", details: err.issues });
    }
    const status =
      typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
        ? err.status
        : 500;
    const message = err instanceof Error ? err.message : "Internal server error";
    const details =
      typeof err === "object" && err !== null && "details" in err ? (err as { details: unknown }).details : undefined;
    if (status >= 500) console.error(err);
    res.status(status).json({ message, ...(details ? { details } : {}) });
  });

  return app;
}
