import "@testing-library/jest-dom/vitest";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";
import { clearAllDetached } from "../signals/utils.ts";

vi.mock("@clerk/clerk-js", () => {
  return {
    Clerk: function MockClerk() {
      return mockedClerk;
    },
  };
});

vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });

  // Override console.error to throw on unexpected errors.
  // - NotSupportedError / AbortError: expected happy-dom noise, silently ignored.
  // - "not wrapped in act(...)": unavoidable with our async bootstrap pattern
  //   (render() runs inside act, then route setup updates page$ outside act).
  //   Silently ignored.
  // - Everything else: thrown so real problems surface early.
  console.error = (...message: unknown[]) => {
    const str = message.map(String).join(" ");
    if (str.includes("NotSupportedError") || str.includes("AbortError")) {
      return;
    }
    if (str.includes("not wrapped in act(")) {
      return;
    }
    throw message[0] as Error;
  };
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
