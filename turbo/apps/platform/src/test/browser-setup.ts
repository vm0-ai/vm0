import "@testing-library/jest-dom/vitest";
import { isCommonAssetRequest } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { mockedClerk } from "../__tests__/mock-auth.ts";
import { worker } from "../mocks/browser.ts";
import { clearAllDetached } from "../signals/utils.ts";

// eslint-disable-next-line ccstate/no-non-zero-api -- matcher for unhandled requests, not an app API call.
const appApiPathPrefix = "/api/";

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

function shouldFailUnhandledRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.pathname.startsWith(appApiPathPrefix)) {
    return true;
  }
  if (url.origin === "http://localhost:3000") {
    return true;
  }
  if (url.origin !== location.origin && !isCommonAssetRequest(request)) {
    return true;
  }
  return false;
}

beforeAll(async () => {
  // Match the happy-dom setup: remove animation timing from UI tests.
  const style = document.createElement("style");
  style.textContent =
    "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; }";
  document.head.appendChild(style);

  await worker.start({
    quiet: true,
    serviceWorker: {
      url: "/mockServiceWorker.js",
    },
    onUnhandledRequest(request, print) {
      if (shouldFailUnhandledRequest(request)) {
        print.error();
      }
    },
  });
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation((...message: unknown[]) => {
    const str = message.map(String).join(" ");
    if (str.includes("AbortError")) {
      return;
    }
    if (str.includes("not wrapped in act(")) {
      return;
    }
    if (str.includes("Detached promise rejected")) {
      return;
    }
    const err = message[0];
    throw err instanceof Error ? err : new Error(err as unknown as string);
  });
});

afterEach(async () => {
  await clearAllDetached();
  worker.resetHandlers();
});

afterAll(() => {
  worker.stop();
});
