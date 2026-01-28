import { server } from "../mocks/server";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  vi.stubEnv("VM0_API_URL", undefined);
});

// Reset handlers after each test
afterEach(() => server.resetHandlers());

// Close server after all tests
afterAll(() => server.close());
