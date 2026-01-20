import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { LogsPage } from "../logs-page.tsx";

// Mock clerk-js
vi.mock("@clerk/clerk-js", () => ({
  Clerk: vi.fn().mockImplementation(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    user: {
      id: "test-user",
      fullName: "Test User",
      primaryEmailAddress: { emailAddress: "test@example.com" },
      imageUrl: "https://example.com/avatar.png",
    },
    addListener: vi.fn().mockReturnValue(() => {}),
    openUserProfile: vi.fn(),
  })),
}));

describe("logs page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render the logs page", () => {
    const store = createStore();

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
