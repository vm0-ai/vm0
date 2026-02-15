import "@testing-library/jest-dom/vitest";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";
import { mockedNango, clearMockedNango } from "../__tests__/mock-nango.ts";
import { clearAllDetached } from "../signals/utils.ts";

vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return mockedClerk;
  },
}));

vi.mock("@nangohq/frontend", () => ({
  default: function MockNango() {
    return mockedNango;
  },
}));

vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

// Reset handlers after each test
afterEach(() => {
  server.resetHandlers();
  clearMockedNango();
});

// Close server after all tests
afterAll(() => {
  server.close();

  return clearAllDetached();
});
