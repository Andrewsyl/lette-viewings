import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Route-aware fetch mock: maps "METHOD /path" prefixes to canned responses. */
export function mockFetchRoutes(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      // Exact path match — prefix matching would let ".../accept" swallow
      // ".../accept-alternative".
      const key = Object.keys(routes).find((k) => {
        const [m, path] = k.split(" ");
        return m === method && url === path;
      });
      if (!key) throw new Error(`Unmocked fetch: ${method} ${url}`);
      const route = routes[key]!;
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
}
