import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  createPushStateMock,
} from "../../../__tests__/page-helper.ts";
import { mockLocation } from "../../location.ts";
import type { LogsListResponse } from "../../zero-page/log-types.ts";
import {
  allScheduleRunAvailableStatuses$,
  allScheduleRunCurrentPage$,
  allScheduleRunData$,
  allScheduleRunHasPrev$,
  allScheduleRunLimit$,
  allScheduleRunStatusFilter$,
  goToNextAllScheduleRunPage$,
  goToPrevAllScheduleRunPage$,
  seedAllScheduleRunCursorHistory$,
  setAllScheduleRunRowsPerPage$,
  setAllScheduleRunStatusFilter$,
} from "../all-schedule-run-history.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract } from "@vm0/core";

const context = testContext();

function emptyLogsResponse(): LogsListResponse {
  return {
    data: [],
    pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
    filters: { statuses: [], sources: [], agents: [] },
  };
}

function logsResponse(
  overrides: Partial<LogsListResponse> = {},
): LogsListResponse {
  return {
    data: [
      {
        id: "c0000000-0000-4000-a000-000000000001",
        sessionId: null,
        agentId: "test-agent",
        displayName: "Test Agent",
        framework: null,
        status: "completed",
        triggerSource: "schedule",
        triggerAgentName: null,
        scheduleId: "sched-abc",
        prompt: "Cross-schedule run prompt",
        createdAt: "2026-04-01T10:00:00Z",
        startedAt: "2026-04-01T10:00:01Z",
        completedAt: "2026-04-01T10:00:30Z",
      },
    ],
    pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
    filters: { statuses: ["completed"], sources: ["schedule"], agents: [] },
    ...overrides,
  };
}

function mockLogsEndpoint(
  response: LogsListResponse,
  captured?: { urls: string[] },
) {
  server.use(
    mockApi(logsListContract.list, ({ request, respond }) => {
      captured?.urls.push(request.url);
      return respond(200, response);
    }),
  );
}

describe("all-schedule-run-history signals", () => {
  describe("allScheduleRunData$", () => {
    it("always fetches with triggerSource=schedule", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });

      const captured = { urls: [] as string[] };
      mockLogsEndpoint(logsResponse(), captured);

      const data = await context.store.get(allScheduleRunData$);

      expect(data.data).toHaveLength(1);
      expect(data.data[0]!.triggerSource).toBe("schedule");

      expect(captured.urls.length).toBeGreaterThan(0);
      const url = new URL(captured.urls[0]!);
      expect(url.searchParams.get("triggerSource")).toBe("schedule");
      expect(url.searchParams.get("limit")).toBe("10");
    });

    it("includes status filter in fetch params", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });
      createPushStateMock(context.signal);

      const captured = { urls: [] as string[] };
      mockLogsEndpoint(logsResponse(), captured);

      context.store.set(setAllScheduleRunStatusFilter$, "failed");

      await context.store.get(allScheduleRunData$);

      const url = new URL(captured.urls[0]!);
      expect(url.searchParams.get("status")).toBe("failed");
      expect(url.searchParams.get("triggerSource")).toBe("schedule");
    });

    it("omits status when filter is 'all'", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });

      const captured = { urls: [] as string[] };
      mockLogsEndpoint(logsResponse(), captured);

      await context.store.get(allScheduleRunData$);

      const url = new URL(captured.urls[0]!);
      expect(url.searchParams.has("status")).toBeFalsy();
    });
  });

  describe("allScheduleRunStatusFilter$", () => {
    it("defaults to all when URL has no runStatus", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "" }, signal);

      expect(store.get(allScheduleRunStatusFilter$)).toBe("all");
    });

    it("reads from URL runStatus param", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules", search: "?runStatus=completed" },
        signal,
      );

      expect(store.get(allScheduleRunStatusFilter$)).toBe("completed");
    });
  });

  describe("setAllScheduleRunStatusFilter$", () => {
    it("updates URL with runStatus param", () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });
      createPushStateMock(context.signal);

      mockLogsEndpoint(emptyLogsResponse());

      context.store.set(setAllScheduleRunStatusFilter$, "failed");

      expect(context.store.get(allScheduleRunStatusFilter$)).toBe("failed");
    });

    it("removes runStatus from URL when set to all", () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });
      createPushStateMock(context.signal);

      mockLogsEndpoint(emptyLogsResponse());

      context.store.set(setAllScheduleRunStatusFilter$, "failed");
      expect(context.store.get(allScheduleRunStatusFilter$)).toBe("failed");

      context.store.set(setAllScheduleRunStatusFilter$, "all");
      expect(context.store.get(allScheduleRunStatusFilter$)).toBe("all");
    });

    it("preserves the active tab param when changing status filter", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?tab=history" }, signal);
      const pushState = createPushStateMock(signal);

      mockLogsEndpoint(emptyLogsResponse());

      store.set(setAllScheduleRunStatusFilter$, "failed");

      // Extract the URL passed to pushState (third argument)
      const lastCall = pushState.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const url = String(lastCall![2]);
      expect(url).toContain("tab=history");
      expect(url).toContain("runStatus=failed");
    });
  });

  describe("pagination", () => {
    it("starts on page 1 with no previous page", () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });

      context.store.set(seedAllScheduleRunCursorHistory$);

      expect(context.store.get(allScheduleRunCurrentPage$)).toBe(1);
      expect(context.store.get(allScheduleRunHasPrev$)).toBeFalsy();
    });

    it("navigates to next page and back", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });
      createPushStateMock(context.signal);

      context.store.set(seedAllScheduleRunCursorHistory$);

      mockLogsEndpoint(
        logsResponse({
          pagination: {
            hasMore: true,
            nextCursor: "cursor-page2",
            totalPages: 3,
          },
        }),
      );

      await context.store.set(goToNextAllScheduleRunPage$, context.signal);

      expect(context.store.get(allScheduleRunCurrentPage$)).toBe(2);
      expect(context.store.get(allScheduleRunHasPrev$)).toBeTruthy();

      context.store.set(goToPrevAllScheduleRunPage$);

      expect(context.store.get(allScheduleRunCurrentPage$)).toBe(1);
      expect(context.store.get(allScheduleRunHasPrev$)).toBeFalsy();
    });

    it("respects limit from URL", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?limit=20" }, signal);

      expect(store.get(allScheduleRunLimit$)).toBe(20);
    });

    it("setRowsPerPage resets pagination to page 1", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });
      createPushStateMock(context.signal);

      context.store.set(seedAllScheduleRunCursorHistory$);

      mockLogsEndpoint(
        logsResponse({
          pagination: {
            hasMore: true,
            nextCursor: "cursor-page2",
            totalPages: 5,
          },
        }),
      );
      await context.store.set(goToNextAllScheduleRunPage$, context.signal);
      expect(context.store.get(allScheduleRunCurrentPage$)).toBe(2);

      context.store.set(setAllScheduleRunRowsPerPage$, 50);

      expect(context.store.get(allScheduleRunLimit$)).toBe(50);
      expect(context.store.get(allScheduleRunCurrentPage$)).toBe(1);
    });
  });

  describe("allScheduleRunAvailableStatuses$", () => {
    it("returns statuses from the server response", async () => {
      detachedSetupPage({ context, path: "/schedules", withoutRender: true });

      mockLogsEndpoint(
        logsResponse({
          filters: {
            statuses: ["completed", "failed"],
            sources: ["schedule"],
            agents: [],
          },
        }),
      );

      const statuses = await context.store.get(
        allScheduleRunAvailableStatuses$,
      );

      expect(statuses).toStrictEqual(["completed", "failed"]);
    });
  });

  describe("seedAllScheduleRunCursorHistory$", () => {
    it("seeds with cursor from URL when present", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules", search: "?cursor=existing-cursor" },
        signal,
      );

      store.set(seedAllScheduleRunCursorHistory$);

      expect(store.get(allScheduleRunCurrentPage$)).toBe(2);
      expect(store.get(allScheduleRunHasPrev$)).toBeTruthy();
    });

    it("seeds without cursor when not in URL", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "" }, signal);

      store.set(seedAllScheduleRunCursorHistory$);

      expect(store.get(allScheduleRunCurrentPage$)).toBe(1);
      expect(store.get(allScheduleRunHasPrev$)).toBeFalsy();
    });
  });
});
