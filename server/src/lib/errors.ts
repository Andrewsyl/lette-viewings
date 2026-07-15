// Small error taxonomy so routes can `next(err)` and the central handler maps to HTTP.

export class NotFoundError extends Error {
  status = 404;
}

/** The requested change collides with current state (double-booking, stale preview). */
export class ConflictError extends Error {
  status = 409;
}

/** LLM unreachable / not configured — the feature is down, the app is not. */
export class LlmUnavailableError extends Error {
  status = 502;
  constructor(message = "The AI service is unavailable right now. Check ANTHROPIC_API_KEY, or try again shortly.") {
    super(message);
  }
}

/** The model's output failed validation even after the repair retry. */
export class LlmOutputError extends Error {
  status = 422;
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}
