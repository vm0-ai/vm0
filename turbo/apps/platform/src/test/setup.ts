import "@testing-library/jest-dom/vitest";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB,
} from "fake-indexeddb";
import { server } from "../mocks/server.ts";
import { afterAll, afterEach, beforeEach, beforeAll, vi } from "vitest";
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
  vi.stubEnv("VITE_ZERO_HOST_DOMAIN", "sites.vm7.io");
});

globalThis.indexedDB = indexedDB;
globalThis.IDBCursor = IDBCursor;
globalThis.IDBCursorWithValue = IDBCursorWithValue;
globalThis.IDBDatabase = IDBDatabase;
globalThis.IDBFactory = IDBFactory;
globalThis.IDBIndex = IDBIndex;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.IDBObjectStore = IDBObjectStore;
globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
globalThis.IDBRequest = IDBRequest;
globalThis.IDBTransaction = IDBTransaction;
globalThis.IDBVersionChangeEvent = IDBVersionChangeEvent;

beforeAll(() => {
  // Disable CSS animations/transitions so Radix UI dialog open/close
  // does not wait for animation frames to settle in act().
  const style = document.createElement("style");
  style.textContent =
    "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; }";
  document.head.appendChild(style);

  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  // Override console.error to throw on unexpected errors.
  // - NotSupportedError / AbortError: expected happy-dom noise, silently ignored.
  // - "not wrapped in act(...)": unavoidable with our async bootstrap pattern
  //   (render() runs inside act, then route setup updates page$ outside act).
  //   Silently ignored.
  // - "suspended inside an `act` scope, but the `act` call was not awaited":
  //   React 19 variant of the same problem — timer-driven detached signals
  //   (polling, fire-and-forget DOM commands) commit after the test scope
  //   has closed. Same root cause as the "not wrapped in act" filter above.
  // - "Detached promise rejected": detach()'s bookkeeping log for non-abort
  //   rejections from DOM-callback flows. The UI surfaces these via toast;
  //   the log is for dev-console visibility, not a test assertion. Silently
  //   ignored so tests can assert on toast/dialog behaviour without needing
  //   to swallow the same rejection at the call site.
  // - Everything else: thrown so real problems surface early.
  vi.spyOn(console, "error").mockImplementation((...message: unknown[]) => {
    const str = message.map(String).join(" ");
    if (str.includes("NotSupportedError") || str.includes("AbortError")) {
      return;
    }
    if (str.includes("not wrapped in act(")) {
      return;
    }
    if (str.includes("suspended inside an `act` scope")) {
      return;
    }
    if (str.includes("Detached promise rejected")) {
      return;
    }
    const err = message[0];
    throw err instanceof Error ? err : new Error(err as unknown as string);
  });
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
