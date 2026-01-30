import { describe, it, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";

const context = testContext();

describe("logs page", () => {
  it("should render the logs page", async () => {
    await setupPage({
      context,
      path: "/logs",
    });

    expect(
      screen.getByText("View all agent runs and execution history."),
    ).toBeDefined();
    expect(context.store.get(pathname$)).toBe("/logs");
  });

  it("should render table headers correctly", async () => {
    await setupPage({
      context,
      path: "/logs",
    });

    await waitFor(() => {
      expect(screen.getByText("Run ID")).toBeInTheDocument();
    });
    expect(screen.getByText("Session ID")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Framework")).toBeInTheDocument();
    expect(screen.getByText("Generate time")).toBeInTheDocument();
  });

  it("should display log entries from API", async () => {
    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Verify mock data is displayed
    expect(screen.getByText("session_1")).toBeInTheDocument();
    // Multiple rows can have claude-code
    const frameworkCells = screen.getAllByText("claude-code");
    expect(frameworkCells.length).toBeGreaterThan(0);
  });

  it("should show empty state when no logs exist", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for empty state to render
    await waitFor(() => {
      expect(screen.getByText("No runs found")).toBeInTheDocument();
    });
  });

  it("should show pagination controls", async () => {
    server.use(
      http.get("*/api/platform/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");

        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: "run_1" }],
            pagination: { hasMore: true, nextCursor: "run_1" },
          });
        }
        return HttpResponse.json({
          data: [{ id: "run_2" }],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", ({ params }) => {
        const { id } = params;
        return HttpResponse.json({
          id,
          sessionId: `session_${id}`,
          agentName: `Agent ${id}`,
          framework: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: null, version: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for pagination controls to appear
    await waitFor(() => {
      expect(screen.getByText("Rows per page")).toBeInTheDocument();
    });
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("should enable next button when hasMore is true", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [{ id: "run_first" }],
          pagination: { hasMore: true, nextCursor: "run_first" },
        });
      }),
      http.get("*/api/platform/logs/:id", ({ params }) => {
        const { id } = params;
        return HttpResponse.json({
          id,
          sessionId: `session_${id}`,
          agentName: `Agent ${id}`,
          framework: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Agent run_first")).toBeInTheDocument();
    });

    // Find navigation buttons (buttons with SVG icons)
    const buttons = screen.getAllByRole("button");
    const iconButtons = buttons.filter((btn) => btn.querySelector("svg"));

    // Should have at least 2 navigation buttons (prev and next)
    expect(iconButtons.length).toBeGreaterThanOrEqual(2);

    // The last icon button (next) should be enabled when hasMore is true
    const nextButton = iconButtons[iconButtons.length - 1];
    expect(nextButton).not.toHaveAttribute("disabled");
  });

  it("should display dash when sessionId is null", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [{ id: "run_no_session" }],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run_no_session",
          sessionId: null,
          agentName: "Test Agent",
          framework: "claude-code",
          status: "pending",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Find the table row and check for dash in session column
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    // First row is header, second is data row
    const dataRow = rows[1];
    expect(dataRow).toBeDefined();
    expect(within(dataRow!).getByText("-")).toBeInTheDocument();
  });

  it("should handle API error gracefully", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json(
          { error: { message: "Internal server error", code: "SERVER_ERROR" } },
          { status: 500 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Should show error message when API fails
    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch logs/)).toBeInTheDocument();
    });
  });
});
