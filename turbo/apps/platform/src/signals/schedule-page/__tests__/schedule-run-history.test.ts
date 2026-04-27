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
  setScheduleRunHistoryScheduleId$,
  seedScheduleRunCursorHistory$,
  scheduleRunData$,
  scheduleRunLimit$,
  scheduleRunHasPrev$,
  scheduleRunCurrentPage$,
  goToNextScheduleRunPage$,
  goToPrevScheduleRunPage$,
  setScheduleRunRowsPerPage$,
  scheduleRunStatusFilter$,
  setScheduleRunStatusFilter$,
  scheduleRunAvailableStatuses$,
} from "../schedule-run-history.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract } from "@vm0/api-contracts/contracts/logs";

const context = testContext();
const mockApi = createMockApi(context);

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
        id: "b0000000-0000-4000-a000-000000000001",
        sessionId: null,
        agentId: "test-agent",
        displayName: "Test Agent",
        framework: null,
        status: "completed",
        triggerSource: "schedule",
        triggerAgentName: null,
        scheduleId: "sched-123",
        prompt: "Scheduled run prompt",
        createdAt: "2026-03-20T10:00:00Z",
        startedAt: "2026-03-20T10:00:01Z",
        completedAt: "2026-03-20T10:00:30Z",
      },
    ],
    pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
    filters: { statuses: ["completed"], sources: ["schedule"], agents: [] },
    ...overrides,
  };
}

/** Intercept GET /api/zero/logs and return a canned response, capturing the request URL. */
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

describe("schedule-run-history signals", () => {
  describe("scheduleRunData$", () => {
    it("returns empty data when no scheduleId is set", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });

      // Don't set scheduleId — buildFetchParams returns null
      const data = await context.store.get(scheduleRunData$);

      expect(data.data).toStrictEqual([]);
      expect(data.pagination.hasMore).toBeFalsy();
    });

    it("fetches logs with scheduleId param", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });

      const captured = { urls: [] as string[] };
      mockLogsEndpoint(logsResponse(), captured);

      context.store.set(setScheduleRunHistoryScheduleId$, "sched-123");

      const data = await context.store.get(scheduleRunData$);

      expect(data.data).toHaveLength(1);
      expect(data.data[0]!.id).toBe("b0000000-0000-4000-a000-000000000001");

      // Verify the fetch URL includes scheduleId
      expect(captured.urls.length).toBeGreaterThan(0);
      const url = new URL(captured.urls[0]!);
      expect(url.searchParams.get("scheduleId")).toBe("sched-123");
      expect(url.searchParams.get("limit")).toBe("10");
    });

    it("includes status filter in fetch params", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });
      createPushStateMock(context.signal);

      const captured = { urls: [] as string[] };
      mockLogsEndpoint(logsResponse(), captured);

      // Set status filter via the command (updates URL properly)
      context.store.set(setScheduleRunStatusFilter$, "failed");
      context.store.set(setScheduleRunHistoryScheduleId$, "sched-456");

      await context.store.get(scheduleRunData$);

      const url = new URL(captured.urls[0]!);
      expect(url.searchParams.get("status")).toBe("failed");
      expect(url.searchParams.get("scheduleId")).toBe("sched-456");
    });
  });

  describe("scheduleRunStatusFilter$", () => {
    it("defaults to all when URL has no runStatus", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/", search: "" }, signal);

      expect(store.get(scheduleRunStatusFilter$)).toBe("all");
    });

    it("reads from URL runStatus param", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/", search: "?runStatus=completed" }, signal);

      expect(store.get(scheduleRunStatusFilter$)).toBe("completed");
    });
  });

  describe("setScheduleRunStatusFilter$", () => {
    it("updates URL with runStatus param", () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });
      createPushStateMock(context.signal);

      mockLogsEndpoint(emptyLogsResponse());

      context.store.set(setScheduleRunStatusFilter$, "failed");

      expect(context.store.get(scheduleRunStatusFilter$)).toBe("failed");
    });

    it("removes runStatus from URL when set to all", () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });
      createPushStateMock(context.signal);

      mockLogsEndpoint(emptyLogsResponse());

      // First set a filter
      context.store.set(setScheduleRunStatusFilter$, "failed");
      expect(context.store.get(scheduleRunStatusFilter$)).toBe("failed");

      // Then clear it
      context.store.set(setScheduleRunStatusFilter$, "all");
      expect(context.store.get(scheduleRunStatusFilter$)).toBe("all");
    });
  });

  describe("pagination", () => {
    it("starts on page 1 with no previous page", () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });

      context.store.set(setScheduleRunHistoryScheduleId$, "sched-1");
      context.store.set(seedScheduleRunCursorHistory$);

      expect(context.store.get(scheduleRunCurrentPage$)).toBe(1);
      expect(context.store.get(scheduleRunHasPrev$)).toBeFalsy();
    });

    it("navigates to next page and back", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });
      createPushStateMock(context.signal);

      context.store.set(setScheduleRunHistoryScheduleId$, "sched-1");
      context.store.set(seedScheduleRunCursorHistory$);

      // Mock first page with hasMore=true
      mockLogsEndpoint(
        logsResponse({
          pagination: {
            hasMore: true,
            nextCursor: "cursor-page2",
            totalPages: 3,
          },
        }),
      );

      // Navigate to next page
      await context.store.set(goToNextScheduleRunPage$, context.signal);

      expect(context.store.get(scheduleRunCurrentPage$)).toBe(2);
      expect(context.store.get(scheduleRunHasPrev$)).toBeTruthy();

      // Navigate back
      context.store.set(goToPrevScheduleRunPage$);

      expect(context.store.get(scheduleRunCurrentPage$)).toBe(1);
      expect(context.store.get(scheduleRunHasPrev$)).toBeFalsy();
    });

    it("respects limit from URL", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/", search: "?limit=20" }, signal);

      expect(store.get(scheduleRunLimit$)).toBe(20);
    });

    it("defaults limit to 10 for invalid values", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/", search: "?limit=15" }, signal);

      expect(store.get(scheduleRunLimit$)).toBe(10);
    });

    it("setRowsPerPage resets pagination to page 1", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });
      createPushStateMock(context.signal);

      context.store.set(setScheduleRunHistoryScheduleId$, "sched-1");
      context.store.set(seedScheduleRunCursorHistory$);

      // Mock page with more data, navigate forward
      mockLogsEndpoint(
        logsResponse({
          pagination: {
            hasMore: true,
            nextCursor: "cursor-page2",
            totalPages: 5,
          },
        }),
      );
      await context.store.set(goToNextScheduleRunPage$, context.signal);
      expect(context.store.get(scheduleRunCurrentPage$)).toBe(2);

      // Change rows per page — should reset to page 1
      context.store.set(setScheduleRunRowsPerPage$, 50);

      expect(context.store.get(scheduleRunLimit$)).toBe(50);
      expect(context.store.get(scheduleRunCurrentPage$)).toBe(1);
    });
  });

  describe("scheduleRunAvailableStatuses$", () => {
    it("returns statuses from the server response", async () => {
      detachedSetupPage({ context, path: "/", withoutRender: true });

      mockLogsEndpoint(
        logsResponse({
          filters: {
            statuses: ["completed", "failed"],
            sources: ["schedule"],
            agents: [],
          },
        }),
      );

      context.store.set(setScheduleRunHistoryScheduleId$, "sched-1");

      const statuses = await context.store.get(scheduleRunAvailableStatuses$);

      expect(statuses).toStrictEqual(["completed", "failed"]);
    });
  });

  describe("seedScheduleRunCursorHistory$", () => {
    it("seeds with cursor from URL when present", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/", search: "?cursor=existing-cursor" },
        signal,
      );

      store.set(setScheduleRunHistoryScheduleId$, "sched-1");
      store.set(seedScheduleRunCursorHistory$);

      // Should be on page 2 since cursor is present
      expect(store.get(scheduleRunCurrentPage$)).toBe(2);
      expect(store.get(scheduleRunHasPrev$)).toBeTruthy();
    });

    it("seeds without cursor when not in URL", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/", search: "" }, signal);

      store.set(setScheduleRunHistoryScheduleId$, "sched-1");
      store.set(seedScheduleRunCursorHistory$);

      expect(store.get(scheduleRunCurrentPage$)).toBe(1);
      expect(store.get(scheduleRunHasPrev$)).toBeFalsy();
    });
  });
});
