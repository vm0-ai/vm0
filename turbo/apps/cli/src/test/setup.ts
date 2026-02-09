import { server } from "../mocks/server";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

// Baseline: no auth, no API URL. Test files override in their own beforeEach.
beforeEach(() => {
  vi.stubEnv("VM0_API_URL", undefined);
  vi.stubEnv("VM0_TOKEN", "");
});

// Reset handlers after each test
afterEach(() => server.resetHandlers());

// Close server after all tests
afterAll(() => server.close());
