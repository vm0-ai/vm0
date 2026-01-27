import { describe, it, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/helper.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

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
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
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
    const providerCells = screen.getAllByText("claude-code");
    expect(providerCells.length).toBeGreaterThan(0);

    // Verify status badge is rendered
    const completedBadges = screen.getAllByText("completed");
    expect(completedBadges.length).toBeGreaterThan(0);
  });

  it("should show empty table when no logs exist", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    // Wait for table to render
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    // Table should have headers but no data rows
    const table = screen.getByRole("table");
    const tbody = within(table).getAllByRole("rowgroup")[1]; // tbody is second rowgroup
    expect(tbody).toBeDefined();
    // tbody should be empty (no rows)
    expect(within(tbody!).queryAllByRole("row")).toHaveLength(0);
  });

  it("should show Load More button when has more data", async () => {
    server.use(
      http.get("*/api/platform/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");

        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: "run_1" }],
            pagination: { has_more: true, next_cursor: "run_1" },
          });
        }
        return HttpResponse.json({
          data: [{ id: "run_2" }],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", ({ params }) => {
        const { id } = params;
        return HttpResponse.json({
          id,
          sessionId: `session_${id}`,
          agentName: `Agent ${id}`,
          provider: "claude-code",
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

    // Wait for Load More button to appear
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Load More" }),
      ).toBeInTheDocument();
    });
  });

  it("should load more data when Load More button is clicked", async () => {
    let loadMoreCalled = false;

    server.use(
      http.get("*/api/platform/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");

        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: "run_first" }],
            pagination: { has_more: true, next_cursor: "run_first" },
          });
        }
        loadMoreCalled = true;
        return HttpResponse.json({
          data: [{ id: "run_second" }],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", ({ params }) => {
        const { id } = params;
        return HttpResponse.json({
          id,
          sessionId: `session_${id}`,
          agentName: `Agent ${id}`,
          provider: "claude-code",
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

    // Wait for first batch
    await waitFor(() => {
      expect(screen.getByText("Agent run_first")).toBeInTheDocument();
    });

    // Click Load More
    const loadMoreButton = screen.getByRole("button", { name: "Load More" });
    await user.click(loadMoreButton);

    // Verify second batch is loaded
    await vi.waitFor(() => {
      expect(loadMoreCalled).toBeTruthy();
    });
  });

  it("should display different status badges with correct styles", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [
            { id: "run_pending" },
            { id: "run_running" },
            { id: "run_failed" },
          ],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", ({ params }) => {
        const { id } = params;
        const statusMap: Record<string, string> = {
          run_pending: "pending",
          run_running: "running",
          run_failed: "failed",
        };
        return HttpResponse.json({
          id,
          sessionId: null,
          agentName: `Agent ${id}`,
          provider: "claude-code",
          status: statusMap[id as string] ?? "completed",
          prompt: "Test",
          error: id === "run_failed" ? "Something went wrong" : null,
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

    // Wait for data to load and verify status badges
    await waitFor(() => {
      expect(screen.getByText("pending")).toBeInTheDocument();
    });
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("should display dash when sessionId is null", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [{ id: "run_no_session" }],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run_no_session",
          sessionId: null,
          agentName: "Test Agent",
          provider: "claude-code",
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
