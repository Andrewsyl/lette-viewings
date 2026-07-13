import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // All test files share one SQLite database — run them sequentially.
    fileParallelism: false,
  },
});
