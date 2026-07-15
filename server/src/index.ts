import { createApp } from "./app.js";
import { env, hasLlmKey } from "./env.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
  if (env.LLM_MODE === "mock") {
    console.log("LLM_MODE=mock — AI features served by the deterministic demo client (no API key needed).");
  } else if (!hasLlmKey) {
    console.warn(
      "ANTHROPIC_API_KEY is not set — NL parsing and message drafting will return 502. " +
        "Set the key, or set LLM_MODE=mock for a keyless demo. Everything else (and the test suite) works without it."
    );
  }
});
