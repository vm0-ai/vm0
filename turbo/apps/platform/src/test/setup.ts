import "@testing-library/jest-dom/vitest";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";
import { clearAllDetached } from "../signals/utils.ts";

vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return mockedClerk;
  },
}));

vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Silence React's "not wrapped in act(...)" warnings that fire when background
// polling loops update state outside of an act() boundary. These warnings are
// expected for detached daemon loops and do not indicate real test problems.
const originalConsoleError = console.error.bind(console);
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    originalConsoleError(...args);
  };
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Reset handlers after each test
afterEach(async () => {
  await clearAllDetached();
  server.resetHandlers();
});

// Close server after all tests
afterAll(() => {
  server.close();
});
