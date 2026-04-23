import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import type {
  LogEntry,
  LogsListResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract } from "@vm0/core/contracts/logs";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  vi.clearAllMocks();
});

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
  filters: Partial<LogsListResponse["filters"]> = {},
): LogsListResponse {
  return {
    data: logs,
    pagination: {
      hasMore: false,
      nextCursor: null,
      totalPages: 1,
      ...overrides,
    },
    filters: {
      statuses: [],
      sources: [],
      agents: [],
      ...filters,
    },
  };
}

function mockLogsAPI(response: LogsListResponse) {
  server.use(
    mockApi(logsListContract.list, ({ respond }) => {
      return respond(200, response);
    }),
  );
}

describe("zeroActivityPage", () => {
  it("should render page title and description", async () => {
    mockLogsAPI(makeLogsResponse([]));
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });
  });

  it("should render agent filter options from availableAgentsLoadable", async () => {
    setMockComposesList([
      {
        id: "agent-1",
        name: "agent-1",
        displayName: "My Agent",
        description: null,
        sound: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(logsListContract.list, ({ respond }) => {
        return respond(
          200,
          makeLogsResponse([makeLog()], {}, { agents: ["agent-1"] }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    const agentFilter = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Agent filter" });
    });

    click(agentFilter);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "All agents" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("should render status filter options from availableStatusesLoadable", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {}, { statuses: ["completed", "failed"] }),
    );
    detachedSetupPage({ context, path: "/activities" });

    const statusFilter = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Status filter" });
    });

    click(statusFilter);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "All status" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Completed" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Failed" }),
      ).toBeInTheDocument();
    });
  });

  it("should render source filter options from availableSourcesLoadable", async () => {
    mockLogsAPI(makeLogsResponse([makeLog()], {}, { sources: ["cli", "web"] }));
    detachedSetupPage({ context, path: "/activities" });

    const sourceFilter = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Source filter" });
    });

    click(sourceFilter);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "All sources" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "CLI" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Web" })).toBeInTheDocument();
    });
  });

  it("should render log table entries from dataLoadable", async () => {
    mockLogsAPI(
      makeLogsResponse([
        makeLog({ displayName: "Alpha Agent", status: "completed" }),
      ]),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Alpha Agent")).toBeInTheDocument();
    });
  });

  it("should render error state when data loading fails", async () => {
    server.use(
      mockApi(logsListContract.list, ({ respond }) => {
        return respond(403, {
          error: {
            message: "Internal server error",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("should render pagination when totalPages is greater than 1", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {
        hasMore: true,
        nextCursor: "cursor-2",
        totalPages: 3,
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("combobox", { name: "Rows per page" }),
    ).toBeInTheDocument();
  });

  it("should not render pagination when totalPages is 1", async () => {
    mockLogsAPI(makeLogsResponse([makeLog()], { totalPages: 1 }));
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Page 1/)).toBeNull();
  });

  it("should filter log table when agent filter changes", async () => {
    const captured = { name: null as string | null };
    setMockComposesList([
      {
        id: "agent-1",
        name: "agent-1",
        displayName: "My Agent",
        description: null,
        sound: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        captured.name = url.searchParams.get("name");
        const name = url.searchParams.get("name");
        const logs =
          name === "agent-1"
            ? [makeLog({ displayName: "Filtered Agent Log" })]
            : [makeLog({ displayName: "All Agents Log" })];
        return respond(
          200,
          makeLogsResponse(logs, {}, { agents: ["agent-1"] }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("All Agents Log")).toBeInTheDocument();
    });

    const agentFilter = screen.getByRole("combobox", { name: "Agent filter" });
    click(agentFilter);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "My Agent" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: "My Agent" }));

    await waitFor(() => {
      expect(screen.getByText("Filtered Agent Log")).toBeInTheDocument();
    });
    expect(captured.name).toBe("agent-1");
  });

  it("should filter log table when status filter changes", async () => {
    const captured = { status: null as string | null };
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        captured.status = url.searchParams.get("status");
        const status = url.searchParams.get("status");
        const logs =
          status === "failed"
            ? [makeLog({ displayName: "Failed Log", status: "failed" })]
            : [makeLog({ displayName: "All Status Log" })];
        return respond(
          200,
          makeLogsResponse(logs, {}, { statuses: ["failed"] }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("All Status Log")).toBeInTheDocument();
    });

    const statusFilter = screen.getByRole("combobox", {
      name: "Status filter",
    });
    click(statusFilter);
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "Failed" }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: "Failed" }));

    await waitFor(() => {
      expect(screen.getByText("Failed Log")).toBeInTheDocument();
    });
    expect(captured.status).toBe("failed");
  });

  it("should filter log table when source filter changes", async () => {
    const captured = { triggerSource: null as string | null };
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        captured.triggerSource = url.searchParams.get("triggerSource");
        const src = url.searchParams.get("triggerSource");
        const logs =
          src === "cli"
            ? [makeLog({ displayName: "CLI Log", triggerSource: "cli" })]
            : [makeLog({ displayName: "All Sources Log" })];
        return respond(200, makeLogsResponse(logs, {}, { sources: ["cli"] }));
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("All Sources Log")).toBeInTheDocument();
    });

    const sourceFilter = screen.getByRole("combobox", {
      name: "Source filter",
    });
    click(sourceFilter);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "CLI" })).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: "CLI" }));

    await waitFor(() => {
      expect(screen.getByText("CLI Log")).toBeInTheDocument();
    });
    expect(captured.triggerSource).toBe("cli");
  });

  it("should advance to next page when next button is clicked", async () => {
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-2") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 2,
            }),
          );
        }
        return respond(
          200,
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 2,
          }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    });

    const nextButton = screen.getByLabelText("Next page");
    expect(nextButton).not.toHaveAttribute("disabled");
    click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });
  });

  it("should go back to previous page when prev button is clicked", async () => {
    let callCount = 0;
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        callCount++;
        if (cursor === "cursor-2") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 2,
            }),
          );
        }
        return respond(
          200,
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 2,
          }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const nextButton = screen.getByLabelText("Next page");
    expect(nextButton).not.toHaveAttribute("disabled");
    click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    const prevButton = screen.getByLabelText("Previous page");
    expect(prevButton).not.toHaveAttribute("disabled");
    click(prevButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
    expect(callCount).toBe(3);
  });

  it("should skip forward two pages when forward two button is clicked", async () => {
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-3") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 3 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 3,
            }),
          );
        }
        if (cursor === "cursor-2") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: true,
              nextCursor: "cursor-3",
              totalPages: 3,
            }),
          );
        }
        return respond(
          200,
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 3,
          }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const forwardTwoButton = screen.getByLabelText("Forward 2 pages");
    expect(forwardTwoButton).not.toHaveAttribute("disabled");
    click(forwardTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });
  });

  it("should go back two pages when back two button is clicked", async () => {
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-3") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 3 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 3,
            }),
          );
        }
        if (cursor === "cursor-2") {
          return respond(
            200,
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: true,
              nextCursor: "cursor-3",
              totalPages: 3,
            }),
          );
        }
        return respond(
          200,
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 3,
          }),
        );
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const forwardTwoButton = screen.getByLabelText("Forward 2 pages");
    click(forwardTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });

    const backTwoButton = screen.getByLabelText("Back 2 pages");
    expect(backTwoButton).not.toHaveAttribute("disabled");
    click(backTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
  });

  it("should change page size when rows per page is changed", async () => {
    const captured = { limit: null as string | null };
    server.use(
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        captured.limit = url.searchParams.get("limit");
        return respond(200, makeLogsResponse([makeLog()], { totalPages: 2 }));
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText(/Page 1/)).toBeInTheDocument();
    });

    const rowsPerPageSelect = screen.getByRole("combobox", {
      name: "Rows per page",
    });
    click(rowsPerPageSelect);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "20" })).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: "20" }));

    await waitFor(() => {
      expect(captured.limit).toBe("20");
    });
  });
});
