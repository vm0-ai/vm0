import { server } from "../mocks/server";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

// Baseline: no auth, no API URL. Test files override in their own beforeEach.
beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", undefined);
  vi.stubEnv("VM0_API_BACKEND_URL", undefined);
  vi.stubEnv("OKOU_APP_URL", undefined);
  vi.stubEnv("OKOU_TOKEN", "");
  vi.stubEnv("ZERO_TOKEN", "");
  vi.stubEnv("OKOU_AGENT_ID", "");
  vi.stubEnv("ZERO_AGENT_ID", "");
  vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
  vi.stubEnv("ZERO_CHAT_THREAD_ID", "");
  vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", undefined);

  vi.stubEnv("SENTRY_DSN", "");
});

// Reset handlers after each test
afterEach(() => {
  return server.resetHandlers();
});

// Close server after all tests
afterAll(() => {
  return server.close();
});
