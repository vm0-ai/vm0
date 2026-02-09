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

    // Verify sessionId and framework fields from list response are displayed
    expect(screen.getByText("session_1")).toBeInTheDocument();
    expect(screen.getAllByText("claude-code").length).toBeGreaterThan(0);
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
      expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    });
  });

  it("should show pagination controls", async () => {
    server.use(
      http.get("*/api/platform/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");

        if (!cursor) {
          return HttpResponse.json({
            data: [
              {
                id: "run_1",
                sessionId: null,
                agentName: "Agent run_1",
                framework: null,
                status: "completed",
                createdAt: "2024-01-01T00:00:00Z",
              },
            ],
            pagination: { hasMore: true, nextCursor: "run_1" },
          });
        }
        return HttpResponse.json({
          data: [
            {
              id: "run_2",
              sessionId: null,
              agentName: "Agent run_2",
              framework: null,
              status: "completed",
              createdAt: "2024-01-02T00:00:00Z",
            },
          ],
          pagination: { hasMore: false, nextCursor: null },
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
          data: [
            {
              id: "run_first",
              sessionId: null,
              agentName: "Agent run_first",
              framework: null,
              status: "completed",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
          pagination: { hasMore: true, nextCursor: "run_first" },
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

  it("should display dash for sessionId and framework columns", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [
            {
              id: "run_no_session",
              sessionId: null,
              agentName: "Test Agent",
              framework: null,
              status: "pending",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
          pagination: { hasMore: false, nextCursor: null },
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

    // Find the table row and check for dash in session and framework columns
    // (These fields are not included in the list response)
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    // First row is header, second is data row
    const dataRow = rows[1];
    expect(dataRow).toBeDefined();
    // Should have 2 dashes (for sessionId and framework columns)
    expect(within(dataRow!).getAllByText("-")).toHaveLength(2);
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

  it("should show skeleton loading state while fetching data", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    server.use(
      http.get("*/api/platform/logs", async () => {
        await requestPromise;
        return HttpResponse.json({
          data: [
            {
              id: "run_test",
              sessionId: "session_test",
              agentName: "Test Agent",
              framework: "claude-code",
              status: "completed",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Should show skeleton while loading
    // Skeleton rows have specific test structure - check for multiple skeleton elements
    const table = screen.getByRole("table");
    const skeletonElements = within(table).getAllByRole("row");
    // Should have header row + multiple skeleton rows (8 in LogsTableSkeleton)
    expect(skeletonElements.length).toBeGreaterThan(1);

    // Resolve the request to show actual data
    resolveRequest?.(true);

    // Wait for actual data to appear
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Verify skeleton is replaced with actual data
    expect(screen.getByText("session_test")).toBeInTheDocument();
  });
});
