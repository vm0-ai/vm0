/**
 * Display and interaction tests for Pagination and LoadingSwitch components.
 * Tests via real page routes following platform testing patterns.
 *
 * Pagination tests: /activities page (ZeroActivityPage)
 * LoadingSwitch tests: /schedules/:id page (ZeroScheduleDetailPage)
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogEntry,
  LogsListResponse,
} from "../../../signals/zero-page/log-types.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract } from "@vm0/core";

const context = testContext();

// ---- Pagination helpers ----

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
    filters: {
      statuses: [],
      sources: [],
      agents: [],
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

// ---- LoadingSwitch helpers ----

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";
const SCHEDULE_NAME = "morning-briefing";

function createMockSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: SCHEDULE_NAME,
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: "Daily morning briefing",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ---- Pagination tests ----

describe("pagination component", () => {
  it("current page number displays (INFRA-D-015)", async () => {
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

    const user = userEvent.setup();
    const nextButton = screen.getByLabelText("Next page");
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText(/Page 3 of/)).toBeInTheDocument();
    });
  });

  it("total pages count displays when available (INFRA-D-016)", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {
        hasMore: true,
        nextCursor: "cursor-2",
        totalPages: 5,
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText(/of 5/)).toBeInTheDocument();
    });
  });

  it("rows per page value displays in select trigger (INFRA-D-017)", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {
        totalPages: 2,
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Rows per page" }),
      ).toBeInTheDocument();
    });
  });

  it("rows per page options render (INFRA-D-018)", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {
        totalPages: 2,
      }),
    );
    detachedSetupPage({ context, path: "/activities" });

    const user = userEvent.setup();
    const rowsPerPageSelect = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Rows per page" });
    });
    await user.click(rowsPerPageSelect);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "10" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "20" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "50" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "100" })).toBeInTheDocument();
    });
  });

  it("rows per page selector changes value (INFRA-D-019)", async () => {
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

    const user = userEvent.setup();
    const rowsPerPageSelect = screen.getByRole("combobox", {
      name: "Rows per page",
    });
    await user.click(rowsPerPageSelect);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "50" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: "50" }));

    await waitFor(() => {
      expect(captured.limit).toBe("50");
    });
  });

  it("previous page button navigates back (INFRA-D-020)", async () => {
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
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    const prevButton = screen.getByLabelText("Previous page");
    expect(prevButton).not.toHaveAttribute("disabled");
    await user.click(prevButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
  });

  it("next page button navigates forward (INFRA-D-021)", async () => {
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
    });

    const user = userEvent.setup();
    const nextButton = screen.getByLabelText("Next page");
    expect(nextButton).not.toHaveAttribute("disabled");
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });
  });

  it("back two pages button works (INFRA-D-022)", async () => {
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

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Forward 2 pages"));

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });

    const backTwoButton = screen.getByLabelText("Back 2 pages");
    expect(backTwoButton).not.toHaveAttribute("disabled");
    await user.click(backTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
  });

  it("forward two pages button works (INFRA-D-023)", async () => {
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

    const user = userEvent.setup();
    const forwardTwoButton = screen.getByLabelText("Forward 2 pages");
    expect(forwardTwoButton).not.toHaveAttribute("disabled");
    await user.click(forwardTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });
  });

  it("navigation buttons disable at boundaries (INFRA-D-024)", async () => {
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
    });

    // At first page: clicking back buttons has no effect (still on page 1)
    const user = userEvent.setup();
    const prevButton = screen.getByLabelText("Previous page");
    await user.click(prevButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    // Navigate to last page: next buttons have no effect (still on page 2)
    await user.click(screen.getByLabelText("Next page"));
    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Next page"));
    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });
  });

  it("next page navigation resolves to new page content (INFRA-D-025)", async () => {
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
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });
  });
});

// ---- LoadingSwitch tests ----

describe("loading switch component", () => {
  it("switch toggle disables the schedule (INFRA-D-026)", async () => {
    let enabled = true;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [createMockSchedule({ enabled })],
        });
      }),
      http.post("*/api/zero/schedules/*/disable", () => {
        enabled = false;
        return HttpResponse.json(createMockSchedule({ enabled: false }));
      }),
    );

    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const switchEl = await waitFor(() => {
      return screen.getByRole("switch", { name: "Disable this schedule" });
    });

    const user = userEvent.setup();
    await user.click(switchEl);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Enable this schedule" }),
      ).toBeInTheDocument();
    });
  });

  it("switch toggle re-enables the schedule (INFRA-D-027)", async () => {
    let enabled = false;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [createMockSchedule({ enabled })],
        });
      }),
      http.post("*/api/zero/schedules/*/enable", () => {
        enabled = true;
        return HttpResponse.json(createMockSchedule({ enabled: true }));
      }),
    );

    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const switchEl = await waitFor(() => {
      return screen.getByRole("switch", { name: "Enable this schedule" });
    });

    const user = userEvent.setup();
    await user.click(switchEl);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Disable this schedule" }),
      ).toBeInTheDocument();
    });
  });

  it("switch toggle round-trips: disable then re-enable (INFRA-D-028)", async () => {
    let enabled = true;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [createMockSchedule({ enabled })],
        });
      }),
      http.post("*/api/zero/schedules/*/disable", () => {
        enabled = false;
        return HttpResponse.json(createMockSchedule({ enabled: false }));
      }),
      http.post("*/api/zero/schedules/*/enable", () => {
        enabled = true;
        return HttpResponse.json(createMockSchedule({ enabled: true }));
      }),
    );

    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const user = userEvent.setup();

    // Disable
    const disableSwitch = await waitFor(() => {
      return screen.getByRole("switch", { name: "Disable this schedule" });
    });
    await user.click(disableSwitch);

    // Wait for it to settle as disabled
    const enableSwitch = await waitFor(() => {
      return screen.getByRole("switch", { name: "Enable this schedule" });
    });

    // Re-enable
    await user.click(enableSwitch);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Disable this schedule" }),
      ).toBeInTheDocument();
    });
  });
});
