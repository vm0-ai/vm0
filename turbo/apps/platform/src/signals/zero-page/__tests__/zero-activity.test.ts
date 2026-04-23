import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  zeroActivityData$,
  zeroActivityHasPrev$,
  initZeroActivityAgentName$,
  setZeroActivityFilter$,
  zeroActivityDetail$,
  formatLogTime,
  formatDuration,
} from "../../activity-page/activity-signals.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { logsListContract, logsByIdContract } from "@vm0/core/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/core/contracts/zero-runs";

const context = testContext();
const mockApi = createMockApi(context);

function logDefaults() {
  return {
    displayName: null,
    triggerSource: "web" as const,
    triggerAgentName: null,
    scheduleId: null,
    prompt: "Test prompt",
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
      framework: "claude-code",
      status: "completed" as const,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:04Z",
    },
    {
      ...logDefaults(),
      id: "a0000000-0000-4000-a000-000000000002",
      sessionId: "session-2",
      agentId: "zero",
      framework: "claude-code",
      status: "failed" as const,
      createdAt: "2026-03-10T14:46:00Z",
    },
    {
      ...logDefaults(),
      id: "a0000000-0000-4000-a000-000000000003",
      sessionId: "session-3",
      agentId: "zero",
      framework: "claude-code",
      status: "running" as const,
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
    status: "completed" as const,
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
        mockApi(logsListContract.list, ({ request, respond }) => {
          const url = new URL(request.url);
          // No name filter → returns all agents' logs
          expect(url.searchParams.has("name")).toBeFalsy();
          return respond(200, {
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
        mockApi(logsListContract.list, ({ respond }) => {
          return respond(200, {
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
        mockApi(logsListContract.list, ({ respond }) => {
          return respond(403, {
            error: {
              message: "Internal server error",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
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
        mockApi(logsListContract.list, ({ respond }) => {
          return respond(200, {
            data: createMockLogs(),
            pagination: {
              hasMore: true,
              nextCursor: "cursor-abc",
              totalPages: 2,
            },
            filters: { statuses: [], sources: [], agents: [] },
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
        mockApi(logsListContract.list, ({ request, respond }) => {
          const url = new URL(request.url);
          captured.status = url.searchParams.get("status");
          return respond(200, {
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
        mockApi(logsByIdContract.getById, ({ params, respond }) => {
          if (params.id === "a0000000-0000-4000-a000-000000000001") {
            return respond(200, createMockLogDetail());
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

      await setupPage({
        context,
        path: "/activities/a0000000-0000-4000-a000-000000000001",
        withoutRender: true,
      });

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
