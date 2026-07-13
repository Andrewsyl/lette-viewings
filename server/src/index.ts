import { createApp } from "./app.js";
import { env, hasLlmKey } from "./env.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
  if (!hasLlmKey) {
    console.warn(
      "ANTHROPIC_API_KEY is not set — NL parsing and message drafting will return 502. " +
        "Everything else (and the test suite) works without it."
    );
  }
});
