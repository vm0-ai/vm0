import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  fetchZeroActivityLogs$,
  zeroActivityLogs$,
  zeroActivityHasMore$,
  setZeroActivitySearch$,
  setZeroActivitySelectedLogId$,
  zeroActivityDetail$,
  logStatusToActivityStatus,
  formatLogTime,
  formatDuration,
} from "../zero-activity.ts";

const context = testContext();

function createMockLogs() {
  return [
    {
      id: "log-1",
      sessionId: "session-1",
      agentName: "zero",
      scopeSlug: "test",
      framework: "claude-code",
      status: "completed",
      createdAt: "2026-03-10T14:56:00Z",
    },
    {
      id: "log-2",
      sessionId: "session-2",
      agentName: "zero",
      scopeSlug: "test",
      framework: "claude-code",
      status: "failed",
      createdAt: "2026-03-10T14:46:00Z",
    },
    {
      id: "log-3",
      sessionId: "session-3",
      agentName: "zero",
      scopeSlug: "test",
      framework: "claude-code",
      status: "running",
      createdAt: "2026-03-10T14:36:00Z",
    },
  ];
}

function createMockLogDetail() {
  return {
    id: "log-1",
    sessionId: "session-1",
    agentName: "zero",
    framework: "claude-code",
    status: "completed",
    prompt: "Summarize today's activity",
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:04Z",
    artifact: { name: null, version: null },
  };
}

async function setup() {
  await setupPage({
    context,
    path: "/zero/activity",
    withoutRender: true,
  });
}

describe("zero-activity signals", () => {
  describe("fetchZeroActivityLogs$", () => {
    it("should fetch logs for the default agent", async () => {
      server.use(
        http.get("http://localhost:3000/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          if (name === "zero") {
            return HttpResponse.json({
              data: createMockLogs(),
              pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
            });
          }
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroActivityLogs$);

      const logs = context.store.get(zeroActivityLogs$);
      expect(logs).toHaveLength(3);
      expect(logs[0]?.id).toBe("log-1");
      expect(logs[0]?.status).toBe("completed");
    });

    it("should handle empty response", async () => {
      server.use(
        http.get("http://localhost:3000/api/platform/logs", () => {
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroActivityLogs$);

      const logs = context.store.get(zeroActivityLogs$);
      expect(logs).toHaveLength(0);
    });

    it("should throw on API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/platform/logs", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await expect(context.store.set(fetchZeroActivityLogs$)).rejects.toThrow(
        "Failed to fetch logs",
      );
    });

    it("should report hasMore from pagination", async () => {
      server.use(
        http.get("http://localhost:3000/api/platform/logs", () => {
          return HttpResponse.json({
            data: createMockLogs(),
            pagination: {
              hasMore: true,
              nextCursor: "cursor-abc",
              totalPages: 2,
            },
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroActivityLogs$);

      expect(context.store.get(zeroActivityHasMore$)).toBeTruthy();
    });
  });

  describe("setZeroActivitySearch$", () => {
    it("should filter logs by search term", async () => {
      const captured: { search: string | null } = { search: null };
      server.use(
        http.get("http://localhost:3000/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          captured.search = url.searchParams.get("search");
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          });
        }),
      );

      await setup();
      await context.store.set(setZeroActivitySearch$, "test query");

      expect(captured.search).toBe("test query");
    });
  });

  describe("zeroActivityDetail$", () => {
    it("should fetch log detail for selected log", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/platform/logs/:logId",
          ({ params }) => {
            if (params["logId"] === "log-1") {
              return HttpResponse.json(createMockLogDetail());
            }
            return new HttpResponse(null, { status: 404 });
          },
        ),
        http.get(
          "http://localhost:3000/api/agent/runs/:runId/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [],
              hasMore: false,
              framework: "claude-code",
            });
          },
        ),
      );

      await setup();
      context.store.set(setZeroActivitySelectedLogId$, "log-1");

      const detail = await context.store.get(zeroActivityDetail$);
      expect(detail).not.toBeNull();
      expect(detail?.prompt).toBe("Summarize today's activity");
      expect(detail?.status).toBe("completed");

      // Clean up: deselect log to stop polling
      context.store.set(setZeroActivitySelectedLogId$, null);
    });
  });

  describe("helper functions", () => {
    it("should convert log status to activity status", () => {
      expect(logStatusToActivityStatus("completed")).toBe("success");
      expect(logStatusToActivityStatus("failed")).toBe("error");
      expect(logStatusToActivityStatus("timeout")).toBe("warning");
      expect(logStatusToActivityStatus("cancelled")).toBe("warning");
      expect(logStatusToActivityStatus("running")).toBe("running");
    });

    it("should format log time", () => {
      const result = formatLogTime("2026-03-10T14:56:00Z");
      // Time is locale-dependent, just check it's a non-empty string
      expect(result).toBeTruthy();
      expect(result).toContain(":");
    });

    it("should format duration", () => {
      expect(
        formatDuration("2026-03-10T14:56:01Z", "2026-03-10T14:56:04Z"),
      ).toBe("3.0s");
      expect(
        formatDuration("2026-03-10T14:56:00Z", "2026-03-10T14:56:00.500Z"),
      ).toBe("500ms");
      expect(
        formatDuration("2026-03-10T14:56:00Z", "2026-03-10T14:58:30Z"),
      ).toBe("2m 30s");
      expect(formatDuration(null, "2026-03-10T14:56:04Z")).toBeUndefined();
      expect(formatDuration("2026-03-10T14:56:01Z", null)).toBeUndefined();
    });
  });
});
