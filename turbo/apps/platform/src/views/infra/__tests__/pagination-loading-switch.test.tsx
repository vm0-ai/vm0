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
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogEntry,
  LogsListResponse,
} from "../../../signals/zero-page/log-types.ts";

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
    http.get("*/api/zero/logs", () => {
      return HttpResponse.json(response);
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

function mockScheduleAPIs(schedule = createMockSchedule()) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [schedule] });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

// ---- Pagination tests ----

describe("pagination component", () => {
  it("current page number displays (INFRA-D-015)", async () => {
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-3") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 3 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 3,
            }),
          );
        }
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: true,
              nextCursor: "cursor-3",
              totalPages: 3,
            }),
          );
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 3,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const nextButton = screen.getByRole("button", { name: "Next page" });
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Next page" }));

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
    await setupPage({ context, path: "/activities" });

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
    await setupPage({ context, path: "/activities" });

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
    await setupPage({ context, path: "/activities" });

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
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        captured.limit = url.searchParams.get("limit");
        return HttpResponse.json(
          makeLogsResponse([makeLog()], { totalPages: 2 }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

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
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 2,
            }),
          );
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 2,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });

    const prevButton = screen.getByRole("button", { name: "Previous page" });
    expect(prevButton).not.toHaveAttribute("disabled");
    await user.click(prevButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
  });

  it("next page button navigates forward (INFRA-D-021)", async () => {
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 2,
            }),
          );
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 2,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const nextButton = screen.getByRole("button", { name: "Next page" });
    expect(nextButton).not.toHaveAttribute("disabled");
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText("Page 2 Log")).toBeInTheDocument();
    });
  });

  it("back two pages button works (INFRA-D-022)", async () => {
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-3") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 3 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 3,
            }),
          );
        }
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: true,
              nextCursor: "cursor-3",
              totalPages: 3,
            }),
          );
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 3,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Forward 2 pages" }));

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });

    const backTwoButton = screen.getByRole("button", { name: "Back 2 pages" });
    expect(backTwoButton).not.toHaveAttribute("disabled");
    await user.click(backTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });
  });

  it("forward two pages button works (INFRA-D-023)", async () => {
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-3") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 3 Log" })], {
              hasMore: false,
              nextCursor: null,
              totalPages: 3,
            }),
          );
        }
        if (cursor === "cursor-2") {
          return HttpResponse.json(
            makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
              hasMore: true,
              nextCursor: "cursor-3",
              totalPages: 3,
            }),
          );
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 3,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const forwardTwoButton = screen.getByRole("button", {
      name: "Forward 2 pages",
    });
    expect(forwardTwoButton).not.toHaveAttribute("disabled");
    await user.click(forwardTwoButton);

    await waitFor(() => {
      expect(screen.getByText("Page 3 Log")).toBeInTheDocument();
    });
  });

  it("navigation buttons disable at boundaries (INFRA-D-024)", async () => {
    mockLogsAPI(
      makeLogsResponse([makeLog()], {
        hasMore: true,
        nextCursor: "cursor-2",
        totalPages: 2,
      }),
    );
    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText(/Page 1/)).toBeInTheDocument();
    });

    const prevButton = screen.getByRole("button", { name: "Previous page" });
    const backTwoButton = screen.getByRole("button", { name: "Back 2 pages" });
    const nextButton = screen.getByRole("button", { name: "Next page" });

    expect(prevButton).toHaveAttribute("disabled");
    expect(backTwoButton).toHaveAttribute("disabled");
    expect(nextButton).not.toHaveAttribute("disabled");
  });

  it("next buttons disable during loading (INFRA-D-025)", async () => {
    let resolveDelayed: ((value: Response) => void) | undefined;

    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (cursor === "cursor-2") {
          return new Promise((resolve) => {
            resolveDelayed = resolve as (value: Response) => void;
          });
        }
        return HttpResponse.json(
          makeLogsResponse([makeLog({ displayName: "Page 1 Log" })], {
            hasMore: true,
            nextCursor: "cursor-2",
            totalPages: 2,
          }),
        );
      }),
    );

    await setupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Page 1 Log")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next page" })).toHaveAttribute(
        "disabled",
      );
      expect(
        screen.getByRole("button", { name: "Forward 2 pages" }),
      ).toHaveAttribute("disabled");
    });

    // Resolve the delayed response to allow cleanup
    resolveDelayed?.(
      HttpResponse.json(
        makeLogsResponse([makeLog({ displayName: "Page 2 Log" })], {
          hasMore: false,
          nextCursor: null,
          totalPages: 2,
        }),
      ) as unknown as Response,
    );
  });
});

// ---- LoadingSwitch tests ----

describe("loading switch component", () => {
  it("loading spinner displays when loading (INFRA-D-026)", async () => {
    let resolveToggle: ((value: Response) => void) | undefined;

    mockScheduleAPIs();
    server.use(
      http.post("*/api/zero/schedules/*/disable", () => {
        return new Promise((resolve) => {
          resolveToggle = resolve as (value: Response) => void;
        });
      }),
      http.post("*/api/zero/schedules/*/enable", () => {
        return new Promise((resolve) => {
          resolveToggle = resolve as (value: Response) => void;
        });
      }),
    );

    await setupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const switchEl = await waitFor(() => {
      return screen.getByRole("switch", { name: "Disable this schedule" });
    });
    expect(switchEl).not.toHaveAttribute("disabled");

    const user = userEvent.setup();
    await user.click(switchEl);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /this schedule/ }),
      ).toHaveAttribute("disabled");
    });

    // Resolve to allow cleanup
    resolveToggle?.(
      HttpResponse.json(
        createMockSchedule({ enabled: false }),
      ) as unknown as Response,
    );
  });

  it("switch toggle fires onCheckedChange (INFRA-D-027)", async () => {
    let toggleCalled = false;

    mockScheduleAPIs();
    server.use(
      http.post("*/api/zero/schedules/*/disable", () => {
        toggleCalled = true;
        return HttpResponse.json(createMockSchedule({ enabled: false }));
      }),
    );

    await setupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const switchEl = await waitFor(() => {
      return screen.getByRole("switch", { name: "Disable this schedule" });
    });

    const user = userEvent.setup();
    await user.click(switchEl);

    await waitFor(() => {
      expect(toggleCalled).toBeTruthy();
    });
  });
});
