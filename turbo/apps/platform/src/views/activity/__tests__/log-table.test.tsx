import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import type {
  LogEntry,
  LogsListResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  logsListContract,
  logsByIdContract,
  zeroRunAgentEventsContract,
} from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session_1",
    agentId: "agent-1",
    displayName: "Test Agent",
    framework: "claude-code",
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Test prompt",
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    ...overrides,
  };
}

function makeLogsResponse(
  logs: LogEntry[],
  overrides: Partial<LogsListResponse["pagination"]> = {},
): LogsListResponse {
  return {
    data: logs,
    pagination: {
      hasMore: false,
      nextCursor: null,
      totalPages: 1,
      ...overrides,
    },
    filters: { statuses: [], sources: [], agents: [] },
  };
}

function mockLogsAPI(response: LogsListResponse) {
  server.use(
    mockApi(logsListContract.list, ({ respond }) => {
      return respond(200, response);
    }),
  );
}

describe("log-table", () => {
  // ACT-D-049
  it("log entries render with all columns", async () => {
    mockLogsAPI(
      makeLogsResponse([
        makeLog({
          displayName: "Alpha Agent",
          triggerSource: "cli",
          status: "completed",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
        }),
      ]),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Alpha Agent")).toBeInTheDocument();
    });

    // Source column (showSource=true on activity page)
    expect(screen.getByText("CLI")).toBeInTheDocument();
    // Status badge label for "completed" is "Done"
    expect(screen.getByText("Done")).toBeInTheDocument();
    // Column headers
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Start Time")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
  });

  // ACT-D-051
  it("empty state renders", async () => {
    mockLogsAPI(makeLogsResponse([]));
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });
  });

  // ACT-D-052
  it("filtered empty state renders", async () => {
    // Apply a status filter via URL so hasActiveFilter becomes true
    mockLogsAPI(makeLogsResponse([]));
    detachedSetupPage({ context, path: "/activities?status=failed" });

    await waitFor(() => {
      expect(screen.getByTestId("filtered-empty-state")).toBeInTheDocument();
    });
  });

  // ACT-D-053
  it("status badge renders per row", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog({ status: "running", completedAt: null })]),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      const badge = screen.getByTestId("status-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("Running");
    });
  });

  // ACT-D-054
  it("duration with spinner for running entries", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog({ status: "running", completedAt: null })]),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      // Running entries show a spinner icon in the duration column
      expect(screen.getByTestId("duration-running")).toBeInTheDocument();
    });

    // The duration column spinner has an accessible label
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
  });

  // ACT-D-055
  it("log row click navigates to detail", async () => {
    const LOG_ID = "b1000000-0000-4000-a000-000000000001";

    mockLogsAPI(
      makeLogsResponse([makeLog({ id: LOG_ID, displayName: "Nav Agent" })]),
    );

    server.use(
      mockApi(logsByIdContract.getById, ({ params, respond }) => {
        if (params.id === LOG_ID) {
          return respond(200, {
            id: LOG_ID,
            sessionId: "session_1",
            agentId: "agent-1",
            displayName: "Nav Agent",
            framework: "claude-code",
            modelProvider: null,
            selectedModel: null,
            triggerSource: "web",
            triggerAgentName: null,
            scheduleId: null,
            status: "completed",
            prompt: "Hello",
            appendSystemPrompt: null,
            error: null,
            createdAt: "2026-03-10T14:56:00Z",
            startedAt: "2026-03-10T14:56:01Z",
            completedAt: "2026-03-10T14:56:10Z",
            artifact: { name: null, version: null },
          });
        }
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      }),
    );

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Nav Agent")).toBeInTheDocument();
    });

    // Click the log row link
    const logRowLink = screen.getByText("Nav Agent").closest("a");
    expect(logRowLink).not.toBeNull();
    click(logRowLink!);

    // After navigation, the detail page should show the agent name as heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Nav Agent" }),
      ).toBeInTheDocument();
    });
  });
});
