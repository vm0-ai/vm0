import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { bootstrap$ } from "../../../signals/bootstrap.ts";
import { navigate$ } from "../../../signals/route.ts";
import { page$ } from "../../../signals/react-router.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupRouter } from "../../main.tsx";

// Mock Clerk BEFORE any module evaluation using vi.hoisted
vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Mock clerk-js
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return {
      user: {
        id: "test-user",
        fullName: "Test User",
      },
      session: {
        getToken: () => Promise.resolve("mock-token"),
      },
      load: () => Promise.resolve(),
      addListener: () => () => {},
    };
  },
}));

const context = testContext();

describe("logs page", () => {
  it("should render the logs page", async () => {
    const { store, signal } = context;

    // Render the router (like main.ts does)
    const { container } = render(<div id="test-root" />);
    const rootEl = container.querySelector("#test-root") as HTMLDivElement;

    // Bootstrap the app (like main.ts does)
    await store.set(
      bootstrap$,
      () => {
        setupRouter(store, (element) => {
          render(element, { container: rootEl });
        });
      },
      signal,
    );

    // Navigate to /logs (this triggers setupLogsPage$ automatically)
    await store.set(navigate$, "/logs", {}, signal);

    // Verify page was rendered
    const pageElement = store.get(page$);
    expect(pageElement).toBeDefined();
  });
});
