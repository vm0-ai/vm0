import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { LogsPage } from "../logs-page.tsx";
import { setPageSignal$ } from "../../../signals/page-signal.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

// Mock Clerk BEFORE any module evaluation using vi.hoisted
vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Mock clerk-js
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return {
      user: null,
      session: {
        getToken: () => Promise.resolve("mock-token"),
      },
      load: () => Promise.resolve(),
      addListener: () => () => {},
    };
  },
}));

// Mock sidebar to avoid @clerk/clerk-react/experimental import
vi.mock("../../layout/sidebar.tsx", () => ({
  Sidebar: () => null,
}));

const context = testContext();

describe("logs page", () => {
  it("should render the logs page", () => {
    const { store, signal } = context;

    // Set page signal before rendering
    store.set(setPageSignal$, signal);

    render(
      <StoreProvider value={store}>
        <LogsPage />
      </StoreProvider>,
    );

    // Check that the page title is rendered (h1 element)
    expect(
      screen.getByRole("heading", { name: "Logs", level: 1 }),
    ).toBeInTheDocument();
  });
});
