import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroActivityData$,
  zeroActivityHasPrev$,
  initZeroActivityAgentName$,
  setZeroActivityFilter$,
  setupActivityLogLoop$,
  zeroActivityDetail$,
  formatLogTime,
  formatDuration,
} from "../../activity-page/activity-signals.ts";

const context = testContext();

function logDefaults() {
  return {
    displayName: null,
    triggerSource: "web" as const,
    triggerAgentName: null,
    scheduleId: null,
    startedAt: null,
    completedAt: null,
  };
}

function createMockLogs() {
  return [
    {
      ...logDefaults(),
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session-1",
      agentId: "zero",
      orgSlug: "test",
      framework: "claude-code",
      status: "completed",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:04Z",
    },
    {
      ...logDefaults(),
      id: "a0000000-0000-4000-a000-000000000002",
      sessionId: "session-2",
      agentId: "zero",
      orgSlug: "test",
      framework: "claude-code",
      status: "failed",
      createdAt: "2026-03-10T14:46:00Z",
    },
    {
      ...logDefaults(),
      id: "a0000000-0000-4000-a000-000000000003",
      sessionId: "session-3",
      agentId: "zero",
      orgSlug: "test",
      framework: "claude-code",
      status: "running",
      createdAt: "2026-03-10T14:36:00Z",
    },
  ];
}

function createMockLogDetail() {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session-1",
    agentId: "zero",
    displayName: null,
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web" as const,
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Summarize today's activity",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:04Z",
    artifact: { name: null, version: null },
  };
}

function setup() {
  detachedSetupPage({
    context,
    path: "/activities",
    withoutRender: true,
  });
}

describe("zero-activity signals", () => {
  describe("zeroActivityData$", () => {
    it("should fetch logs for all agents in org", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/logs", ({ request }) => {
          const url = new URL(request.url);
          // No name filter → returns all agents' logs
          expect(url.searchParams.has("name")).toBeFalsy();
          return HttpResponse.json({
            data: createMockLogs(),
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
            filters: { statuses: [], sources: [], agents: [] },
          });
        }),
      );

      await setup();
      await context.store.set(initZeroActivityAgentName$, context.signal);

      const response = await context.store.get(zeroActivityData$);
      expect(response.data).toHaveLength(3);
      expect(response.data[0]?.id).toBe("a0000000-0000-4000-a000-000000000001");
      expect(response.data[0]?.status).toBe("completed");
    });

    it("should handle empty response", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/logs", () => {
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
            filters: { statuses: [], sources: [], agents: [] },
          });
        }),
      );

      await setup();
      await context.store.set(initZeroActivityAgentName$, context.signal);

      const response = await context.store.get(zeroActivityData$);
      expect(response.data).toHaveLength(0);
    });

    it("should throw on API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/logs", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "INTERNAL_SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await setup();
      await context.store.set(initZeroActivityAgentName$, context.signal);

      await expect(context.store.get(zeroActivityData$)).rejects.toThrow(
        "Internal server error",
      );
    });

    it("should report hasPrev as false on first page", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/logs", () => {
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
      await context.store.set(initZeroActivityAgentName$, context.signal);

      expect(context.store.get(zeroActivityHasPrev$)).toBeFalsy();
    });
  });

  describe("setZeroActivityFilter$", () => {
    it("should pass status filter to API query params", async () => {
      const captured: { status: string | null } = { status: null };
      server.use(
        http.get("http://localhost:3000/api/zero/logs", ({ request }) => {
          const url = new URL(request.url);
          captured.status = url.searchParams.get("status");
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
            filters: { statuses: [], sources: [], agents: [] },
          });
        }),
      );

      await setup();
      await context.store.set(initZeroActivityAgentName$, context.signal);
      context.store.set(setZeroActivityFilter$, "status", "completed");
      // The computed data$ will re-fetch with the new status param
      await context.store.get(zeroActivityData$);

      expect(captured.status).toBe("completed");
    });
  });

  describe("zeroActivityDetail$", () => {
    it("should fetch log detail for selected log", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/logs/:logId", ({ params }) => {
          if (params["logId"] === "a0000000-0000-4000-a000-000000000001") {
            return HttpResponse.json(createMockLogDetail());
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get(
          "http://localhost:3000/api/zero/runs/:runId/telemetry/agent",
          () => {
            return HttpResponse.json({
              events: [],
              hasMore: false,
              framework: "claude-code",
            });
          },
        ),
      );

      detachedSetupPage({
        context,
        path: "/activities/a0000000-0000-4000-a000-000000000001",
        withoutRender: true,
      });
      await context.store.set(setupActivityLogLoop$, context.signal);

      const detail = await context.store.get(zeroActivityDetail$);
      expect(detail).not.toBeNull();
      expect(detail?.prompt).toBe("Summarize today's activity");
      expect(detail?.status).toBe("completed");
    });
  });

  describe("helper functions", () => {
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
