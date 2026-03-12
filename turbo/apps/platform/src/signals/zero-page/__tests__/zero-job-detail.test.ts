import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import {
  zeroJobDetail$,
  zeroJobDetailLoading$,
  zeroJobDetailError$,
  zeroJobInstructions$,
  zeroJobInstructionsLoading$,
  zeroJobInstructionsError$,
  zeroJobScheduleEntries$,
  zeroJobScheduleError$,
  fetchZeroJobData$,
} from "../zero-job-detail";

const context = testContext();

function mockAgentResponse() {
  return {
    id: "compose-1",
    name: "my-agent",
    headVersionId: "v1",
    content: {
      version: "1",
      agents: {
        main: {
          description: "A test agent",
          framework: "claude",
          skills: ["search"],
        },
      },
    },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-06-15T12:00:00Z",
  };
}

function mockInstructions() {
  return {
    content: "# Instructions\nDo the thing.",
    filename: "instructions.md",
  };
}

function mockSchedules() {
  return {
    schedules: [
      {
        id: "sched-1",
        composeId: "compose-1",
        composeName: "my-agent",
        name: "daily-run",
        enabled: true,
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        atTime: null,
        intervalSeconds: null,
        timezone: "UTC",
        prompt: "Run the daily digest",
        createdAt: "2024-06-01T00:00:00Z",
      },
      {
        id: "sched-2",
        composeId: "compose-2",
        composeName: "other-agent",
        name: "other-run",
        enabled: true,
        triggerType: "cron",
        cronExpression: "0 12 * * *",
        atTime: null,
        intervalSeconds: null,
        timezone: "UTC",
        prompt: "Something else",
        createdAt: "2024-06-01T00:00:00Z",
      },
    ],
  };
}

describe("zero-job-detail signals", () => {
  describe("fetchZeroJobData$", () => {
    it("should fetch detail, instructions, and schedules successfully", async () => {
      const agentResponse = mockAgentResponse();
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(agentResponse);
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      const detail = context.store.get(zeroJobDetail$);
      const loading = context.store.get(zeroJobDetailLoading$);
      const error = context.store.get(zeroJobDetailError$);

      expect(detail).toStrictEqual({ ...agentResponse, isOwner: true });
      expect(loading).toBeFalsy();
      expect(error).toBeNull();

      const instructions = context.store.get(zeroJobInstructions$);
      const instructionsLoading = context.store.get(
        zeroJobInstructionsLoading$,
      );
      const instructionsError = context.store.get(zeroJobInstructionsError$);

      expect(instructions).toStrictEqual(mockInstructions());
      expect(instructionsLoading).toBeFalsy();
      expect(instructionsError).toBeNull();

      const entries = await context.store.get(zeroJobScheduleEntries$);
      const scheduleError = context.store.get(zeroJobScheduleError$);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("daily-run");
      expect(entries[0]!.time).toBe("Every day at 9:00 AM");
      expect(scheduleError).toBeNull();
    });

    it("should set error state when detail API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: "Not Found" },
            { status: 404, statusText: "Not Found" },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "missing-agent");

      const detail = context.store.get(zeroJobDetail$);
      const loading = context.store.get(zeroJobDetailLoading$);
      const error = context.store.get(zeroJobDetailError$);

      expect(detail).toBeNull();
      expect(loading).toBeFalsy();
      expect(error).toBe("Failed to fetch agent: Not Found");
    });

    it("should set instructions error when instructions API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(
              { error: "Internal Server Error" },
              { status: 500, statusText: "Internal Server Error" },
            );
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      const instructions = context.store.get(zeroJobInstructions$);
      const instructionsError = context.store.get(zeroJobInstructionsError$);

      expect(instructions).toBeNull();
      expect(instructionsError).toBe(
        "Failed to fetch instructions: Internal Server Error",
      );

      // Detail should still succeed
      expect(context.store.get(zeroJobDetail$)).not.toBeNull();
    });

    it("should set schedule error when schedules API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            { error: "Forbidden" },
            { status: 403, statusText: "Forbidden" },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      const entries = await context.store.get(zeroJobScheduleEntries$);
      const scheduleError = context.store.get(zeroJobScheduleError$);

      expect(entries).toStrictEqual([]);
      expect(scheduleError).toBe("Failed to fetch schedules: Forbidden");

      // Detail and instructions should still succeed
      expect(context.store.get(zeroJobDetail$)).not.toBeNull();
      expect(context.store.get(zeroJobInstructions$)).not.toBeNull();
    });

    it("should parse scoped agent name correctly", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");
          const scope = url.searchParams.get("scope");

          expect(name).toBe("sub-agent");
          expect(scope).toBe("my-org");

          return HttpResponse.json({
            ...mockAgentResponse(),
            name: "sub-agent",
          });
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-org/sub-agent");

      const detail = context.store.get(zeroJobDetail$);
      expect(detail).not.toBeNull();
      expect(detail!.isOwner).toBeFalsy();
    });
  });
});
