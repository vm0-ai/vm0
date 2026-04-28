import type { HttpHandler } from "msw";

// Default handlers are intentionally empty: integration tests register the
// upstreams they care about per-test via `server.use(...)`. The MSW server is
// configured with `onUnhandledRequest: "error"` so any unmocked outbound
// fetch fails loudly.
export const handlers: readonly HttpHandler[] = [];
