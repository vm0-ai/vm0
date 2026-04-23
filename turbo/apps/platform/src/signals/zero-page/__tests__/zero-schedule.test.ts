import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/core/contracts/zero-schedules";
import {
  fetchZeroSchedules$,
  zeroScheduleEntries$,
  saveZeroSchedule$,
  deleteZeroSchedule$,
  toggleZeroScheduleEnabled$,
  fetchAllOrgSchedules$,
  allOrgScheduleEntries$,
  saveOrgSchedule$,
  toggleOrgScheduleEnabled$,
  deleteOrgSchedule$,
  runScheduleNow$,
} from "../zero-schedule.ts";

const context = testContext();
const mockApi = createMockApi(context);

afterEach(() => {
  vi.restoreAllMocks();
});

function mockScheduleResponse(): ScheduleResponse {
  return createMockScheduleResponse({
    id: "d0000000-0000-4000-a000-000000000001",
    name: "new-schedule",
    cronExpression: "0 9 * * *",
    prompt: "test",
  });
}

function mockDeployResponse() {
  return {
    schedule: mockScheduleResponse(),
    created: true,
  };
}

function createMockSchedules(): ScheduleResponse[] {
  return [
    createMockScheduleResponse({
      id: "a0000001-0000-4000-a000-000000000001",
      name: "morning-briefing",
      cronExpression: "0 9 * * 1-5",
      prompt: "Summarize yesterday's threads",
    }),
    createMockScheduleResponse({
      id: "a0000001-0000-4000-a000-000000000002",
      name: "check-inbox",
      triggerType: "loop",
      cronExpression: null,
      intervalSeconds: 900,
      prompt: "Check inbox for urgent items",
    }),
    createMockScheduleResponse({
      id: "a0000001-0000-4000-a000-000000000003",
      agentId: "a0000001-0000-4000-a000-000000000020",
      name: "other-schedule",
      cronExpression: "0 12 * * *",
      prompt: "This belongs to another agent",
    }),
  ];
}

function setup() {
  detachedSetupPage({
    context,
    path: "/schedules",
    withoutRender: true,
  });
}

describe("zero-schedule signals", () => {
  describe("fetchZeroSchedules$", () => {
    it("should fetch and filter schedules for the default agent", async () => {
      setMockSchedules(createMockSchedules());

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.prompt).toBe("Summarize yesterday's threads");
      expect(entries[1]?.prompt).toBe("Check inbox for urgent items");
    });

    it("should convert cron schedule to display string", async () => {
      setMockSchedules(createMockSchedules());

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every weekday at 9:00 AM");
    });

    it("should convert loop schedule to display string", async () => {
      setMockSchedules(createMockSchedules());

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[1]?.time).toBe("Every 15 minutes");
    });

    it("should handle empty response", async () => {
      setMockSchedules([]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(0);
    });

    it("should propagate API errors", async () => {
      // The background bootstrap also hits GET /api/zero/schedules via
      // fetchAllOrgSchedules$. Use a request counter so the first call
      // (bootstrap) succeeds and the second call (explicit test) gets 401.
      let requestCount = 0;
      server.use(
        mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
          requestCount++;
          if (requestCount > 1) {
            return respond(401, {
              error: {
                message: "Internal server error",
                code: "INTERNAL_SERVER_ERROR",
              },
            });
          }
          return respond(200, { schedules: [] });
        }),
      );

      // Await bootstrap so the first schedule fetch (from route setup)
      // completes deterministically before the test's explicit call.
      await setupPage({
        context,
        path: "/schedules",
        withoutRender: true,
      });

      await expect(
        context.store.set(fetchZeroSchedules$, context.signal),
      ).rejects.toThrow("Internal server error");
    });
  });

  describe("saveZeroSchedule$", () => {
    it("should POST a cron schedule and refresh the list", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Daily standup summary",
          freq: "every_day",
          date: "2026-03-15",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 900,
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.agentId).toBe(
        "c0000000-0000-4000-a000-000000000001",
      );
      expect(captured.body?.prompt).toBe("Daily standup summary");
      expect(captured.body?.cronExpression).toBe("0 9 * * *");
      expect(captured.body?.timezone).toBe("UTC");
      expect(captured.body?.enabled).toBeTruthy();
    });

    it("should POST a loop schedule", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Check inbox",
          freq: "every_n_minutes",
          date: "2026-03-15",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 900,
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.intervalSeconds).toBe(900);
    });

    it("should use editName when editing an existing schedule", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Updated prompt",
          freq: "every_weekday",
          date: "2026-03-15",
          hour: 10,
          minute: 30,
          timezone: "America/New_York",
          intervalSeconds: 900,
          editName: "existing-schedule",
        },
        context.signal,
      );

      expect(captured.body?.name).toBe("existing-schedule");
      expect(captured.body?.cronExpression).toBe("30 10 * * 1-5");
    });

    it("should POST a one-time schedule with atTime", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "One-time task",
          freq: "once",
          date: "2030-06-15",
          hour: 14,
          minute: 30,
          timezone: "UTC",
          intervalSeconds: 0,
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.atTime).toBeDefined();
      expect(captured.body).not.toHaveProperty("cronExpression");
      expect(captured.body).not.toHaveProperty("intervalSeconds");
    });

    it("should POST a weekly schedule with dayOfWeek", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Weekly report",
          freq: "every_week",
          date: "2026-03-15",
          hour: 10,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          dayOfWeek: "5",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.cronExpression).toBe("0 10 * * 5");
    });

    it("should POST a monthly schedule with dayOfMonth", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Monthly review",
          freq: "every_month",
          date: "2026-03-15",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          dayOfMonth: "15",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.cronExpression).toBe("0 9 15 * *");
    });

    it("should include description in POST body when provided", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveZeroSchedule$,
        {
          prompt: "Described task",
          description: "Custom description here",
          freq: "every_day",
          date: "2026-03-15",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.description).toBe("Custom description here");
    });

    it("should toast on pre-API validation error (past atTime)", async () => {
      const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => {
        return "" as unknown as ReturnType<typeof toast.error>;
      });

      await setup();
      await expect(
        context.store.set(
          saveZeroSchedule$,
          {
            prompt: "One-time task in the past",
            freq: "once",
            date: "2000-01-01",
            hour: 9,
            minute: 0,
            timezone: "UTC",
            intervalSeconds: 0,
          },
          context.signal,
        ),
      ).rejects.toThrow("Scheduled time must be in the future");

      expect(errorSpy).toHaveBeenCalledWith(
        "Scheduled time must be in the future",
      );
    });

    it("should not toast when save is aborted mid-flight", async () => {
      // Aborts on DomCallback paths (e.g. navigation, unmount) are silent by
      // design — detach() swallows AbortError. The error-toast helper must
      // not surface these as user-visible toasts.
      const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => {
        return "" as unknown as ReturnType<typeof toast.error>;
      });

      await setup();

      await expect(
        context.store.set(
          saveZeroSchedule$,
          {
            prompt: "Aborted save",
            freq: "every_day",
            date: "2030-01-01",
            hour: 9,
            minute: 0,
            timezone: "UTC",
            intervalSeconds: 0,
          },
          AbortSignal.abort(),
        ),
      ).rejects.toThrow();

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("should throw on API error during save", async () => {
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
          return respond(400, {
            error: { message: "Invalid timezone", code: "BAD_REQUEST" },
          });
        }),
      );

      await setup();
      await expect(
        context.store.set(
          saveZeroSchedule$,
          {
            prompt: "Bad save",
            freq: "every_day",
            date: "2026-03-15",
            hour: 9,
            minute: 0,
            timezone: "Invalid/TZ",
            intervalSeconds: 0,
          },
          context.signal,
        ),
      ).rejects.toThrow("Invalid timezone");
    });
  });

  describe("toggleZeroScheduleEnabled$", () => {
    it("should POST to enable endpoint and refresh schedules", async () => {
      const captured: {
        action: string | null;
        body: Record<string, unknown> | null;
      } = { action: null, body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesEnableContract.enable, ({ body, respond }) => {
          captured.action = "enable";
          captured.body = body as Record<string, unknown>;
          return respond(200, mockScheduleResponse());
        }),
      );

      await setup();
      await context.store.set(
        toggleZeroScheduleEnabled$,
        {
          name: "morning-briefing",
          enabled: true,
        },
        context.signal,
      );

      expect(captured.action).toBe("enable");
      expect(captured.body?.agentId).toBe(
        "c0000000-0000-4000-a000-000000000001",
      );
    });

    it("should POST to disable endpoint when enabled is false", async () => {
      const captured: { action: string | null } = { action: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
          captured.action = "disable";
          return respond(200, mockScheduleResponse());
        }),
      );

      await setup();
      await context.store.set(
        toggleZeroScheduleEnabled$,
        {
          name: "morning-briefing",
          enabled: false,
        },
        context.signal,
      );

      expect(captured.action).toBe("disable");
    });

    it("should throw and show toast on API error", async () => {
      server.use(
        mockApi(zeroSchedulesEnableContract.enable, ({ respond }) => {
          return respond(404, {
            error: { message: "Schedule not found", code: "NOT_FOUND" },
          });
        }),
      );

      await setup();
      await expect(
        context.store.set(
          toggleZeroScheduleEnabled$,
          {
            name: "nonexistent",
            enabled: true,
          },
          context.signal,
        ),
      ).rejects.toThrow("Schedule not found");
    });

    it("should optimistically update local state without refetching", async () => {
      let fetchCount = 0;

      server.use(
        mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
          fetchCount++;
          return respond(200, {
            schedules: createMockSchedules(),
          });
        }),
        mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
          return respond(200, mockScheduleResponse());
        }),
        mockApi(zeroSchedulesEnableContract.enable, ({ respond }) => {
          return respond(200, mockScheduleResponse());
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entriesBefore = context.store.get(zeroScheduleEntries$);
      const enabledEntry = entriesBefore.find((e) => {
        return e.name === "morning-briefing";
      });
      expect(enabledEntry?.enabled).toBeTruthy();
      const fetchCountAfterInit = fetchCount;

      await context.store.set(
        toggleZeroScheduleEnabled$,
        { name: "morning-briefing", enabled: false },
        context.signal,
      );

      const entriesAfter = context.store.get(zeroScheduleEntries$);
      const toggledEntry = entriesAfter.find((e) => {
        return e.name === "morning-briefing";
      });
      expect(toggledEntry?.enabled).toBeFalsy();
      // No additional schedule list fetch should have happened
      expect(fetchCount).toBe(fetchCountAfterInit);
    });
  });

  describe("runScheduleNow$", () => {
    it("should POST to run endpoint and return runId", async () => {
      let capturedBody: Record<string, unknown> | null = null;

      server.use(
        mockApi(zeroScheduleRunContract.run, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, { runId: "run-abc-123" });
        }),
      );

      await setup();
      const runId = await context.store.set(
        runScheduleNow$,
        "sched-1",
        context.signal,
      );

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!["scheduleId"]).toBe("sched-1");
      expect(runId).toBe("run-abc-123");
    });

    it("should throw on API error", async () => {
      server.use(
        mockApi(zeroScheduleRunContract.run, ({ respond }) => {
          return respond(404, {
            error: { message: "Schedule not found", code: "NOT_FOUND" },
          });
        }),
      );

      await setup();
      await expect(
        context.store.set(runScheduleNow$, "nonexistent-id", context.signal),
      ).rejects.toThrow("Schedule not found");
    });

    it("should throw on conflict when previous run is active", async () => {
      server.use(
        mockApi(zeroScheduleRunContract.run, ({ respond }) => {
          return respond(409, {
            error: {
              message: "Previous run is still active",
              code: "CONFLICT",
            },
          });
        }),
      );

      await setup();
      await expect(
        context.store.set(runScheduleNow$, "sched-1", context.signal),
      ).rejects.toThrow("Previous run is still active");
    });
  });

  describe("schedule display strings", () => {
    it("should convert one-time schedule to display string", async () => {
      setMockSchedules([
        createMockScheduleResponse({
          id: "b0000000-0000-4000-a000-000000000001",
          name: "one-time",
          triggerType: "once",
          cronExpression: null,
          atTime: "2026-06-15T14:30:00.000Z",
          prompt: "One-time task",
        }),
      ]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.time).toMatch(/^Once on 2026-06-15 at/);
    });

    it("should convert daily cron to display string", async () => {
      setMockSchedules([
        createMockScheduleResponse({
          id: "b0000000-0000-4000-a000-000000000002",
          name: "daily",
          cronExpression: "0 14 * * *",
          prompt: "Daily task",
        }),
      ]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every day at 2:00 PM");
    });

    it("should convert monthly cron to display string", async () => {
      setMockSchedules([
        createMockScheduleResponse({
          id: "b0000000-0000-4000-a000-000000000003",
          name: "monthly",
          cronExpression: "0 9 15 * *",
          prompt: "Monthly task",
        }),
      ]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every month on day 15 at 9:00 AM");
    });

    it("should convert weekly cron to display string with day name", async () => {
      setMockSchedules([
        createMockScheduleResponse({
          id: "b0000000-0000-4000-a000-000000000004",
          name: "weekly",
          cronExpression: "0 10 * * 3",
          prompt: "Weekly task",
        }),
      ]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every week on Wednesday at 10:00 AM");
    });

    it("should include description in entries", async () => {
      setMockSchedules([
        createMockScheduleResponse({
          id: "b0000000-0000-4000-a000-000000000005",
          name: "described",
          prompt: "Task with description",
          description: "A detailed description",
        }),
      ]);

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.description).toBe("A detailed description");
    });
  });

  describe("deleteZeroSchedule$", () => {
    it("should DELETE a schedule and refresh the list", async () => {
      let deletedName: string | null = null;
      let deletedAgentId: string | null = null;

      setMockSchedules([]);
      server.use(
        mockApi(
          zeroSchedulesByNameContract.delete,
          ({ params, request, respond }) => {
            deletedName = params.name;
            const url = new URL(request.url);
            deletedAgentId = url.searchParams.get("agentId");
            return respond(204);
          },
        ),
      );

      await setup();
      await context.store.set(
        deleteZeroSchedule$,
        "morning-briefing",
        context.signal,
      );

      expect(deletedName).toBe("morning-briefing");
      expect(deletedAgentId).toBe("c0000000-0000-4000-a000-000000000001");
    });
  });
});

describe("org schedule signals", () => {
  function setup() {
    detachedSetupPage({
      context,
      path: "/schedules",
      withoutRender: true,
    });
  }

  describe("fetchAllOrgSchedules$ and allOrgScheduleEntries$", () => {
    it("should map agentId field from API response", async () => {
      setMockSchedules(createMockSchedules());

      await setup();
      await context.store.set(fetchAllOrgSchedules$, context.signal);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries).toHaveLength(3);

      const zeroEntry = entries.find((e) => {
        return e.name === "morning-briefing";
      });
      expect(zeroEntry?.agentId).toBe("c0000000-0000-4000-a000-000000000001");

      const otherEntry = entries.find((e) => {
        return e.name === "other-schedule";
      });
      expect(otherEntry?.agentId).toBe("a0000001-0000-4000-a000-000000000020");
    });
  });

  describe("saveOrgSchedule$", () => {
    it("should send agentId in POST body", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveOrgSchedule$,
        {
          prompt: "Org-wide daily task",
          freq: "every_day",
          date: "2030-01-01",
          hour: 8,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          agentId: "e0000000-0000-4000-a000-000000000010",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.agentId).toBe(
        "e0000000-0000-4000-a000-000000000010",
      );
      expect(captured.body).not.toHaveProperty("composeId");
      expect(captured.body?.prompt).toBe("Org-wide daily task");
      expect(captured.body?.cronExpression).toBe("0 8 * * *");
    });

    it("should preserve non-UTC timezone in POST body", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          captured.body = body as Record<string, unknown>;
          return respond(201, mockDeployResponse());
        }),
      );

      await setup();
      await context.store.set(
        saveOrgSchedule$,
        {
          prompt: "Instruction edit save",
          freq: "every_weekday",
          date: "2030-01-01",
          hour: 9,
          minute: 0,
          timezone: "Asia/Shanghai",
          intervalSeconds: 0,
          agentId: "e0000000-0000-4000-a000-000000000010",
          editName: "existing-schedule",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.timezone).toBe("Asia/Shanghai");
      expect(captured.body?.name).toBe("existing-schedule");
    });

    // A validation error thrown inside saveOrgSchedule$ (before the API call)
    // must surface as a toast. These errors propagate out of ccstate commands
    // and are silently swallowed by detach(Reason.DomCallback) in the views,
    // so without an explicit toast the user sees no feedback on save failure.
    it("should toast on pre-API validation error (past atTime)", async () => {
      const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => {
        return "" as unknown as ReturnType<typeof toast.error>;
      });

      await setup();
      await expect(
        context.store.set(
          saveOrgSchedule$,
          {
            prompt: "One-time task in the past",
            freq: "once",
            date: "2000-01-01",
            hour: 9,
            minute: 0,
            timezone: "UTC",
            intervalSeconds: 0,
            agentId: "e0000000-0000-4000-a000-000000000010",
          },
          context.signal,
        ),
      ).rejects.toThrow("Scheduled time must be in the future");

      expect(errorSpy).toHaveBeenCalledWith(
        "Scheduled time must be in the future",
      );
    });
  });

  describe("toggleOrgScheduleEnabled$", () => {
    it("should send agentId in toggle request body", async () => {
      const captured: {
        action: string | null;
        body: Record<string, unknown> | null;
      } = { action: null, body: null };

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesEnableContract.disable, ({ body, respond }) => {
          captured.action = "disable";
          captured.body = body as Record<string, unknown>;
          return respond(200, mockScheduleResponse());
        }),
      );

      await setup();
      await context.store.set(
        toggleOrgScheduleEnabled$,
        {
          name: "morning-briefing",
          enabled: false,
          agentId: "e0000000-0000-4000-a000-000000000010",
        },
        context.signal,
      );

      expect(captured.action).toBe("disable");
      expect(captured.body?.agentId).toBe(
        "e0000000-0000-4000-a000-000000000010",
      );
      expect(captured.body).not.toHaveProperty("composeId");
    });
  });

  describe("deleteOrgSchedule$", () => {
    it("should send agentId as query param in DELETE request", async () => {
      let deletedName: string | null = null;
      let deletedAgentId: string | null = null;

      setMockSchedules([]);
      server.use(
        mockApi(
          zeroSchedulesByNameContract.delete,
          ({ params, request, respond }) => {
            deletedName = params.name;
            const url = new URL(request.url);
            deletedAgentId = url.searchParams.get("agentId");
            return respond(204);
          },
        ),
      );

      await setup();
      await context.store.set(
        deleteOrgSchedule$,
        {
          name: "morning-briefing",
          agentId: "e0000000-0000-4000-a000-000000000010",
        },
        context.signal,
      );

      expect(deletedName).toBe("morning-briefing");
      expect(deletedAgentId).toBe("e0000000-0000-4000-a000-000000000010");
    });
  });
});
