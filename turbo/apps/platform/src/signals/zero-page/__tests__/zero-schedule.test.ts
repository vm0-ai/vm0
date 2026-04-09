import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
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

function mockScheduleResponse() {
  return {
    ...scheduleDefaults(),
    id: "d0000000-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    name: "new-schedule",
    triggerType: "cron" as const,
    cronExpression: "0 9 * * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "test",
    description: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function mockDeployResponse() {
  return {
    schedule: mockScheduleResponse(),
    created: true,
  };
}

function scheduleDefaults() {
  return {
    displayName: null,
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    artifactName: null,
    artifactVersion: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
  };
}

function createMockSchedules() {
  return [
    {
      ...scheduleDefaults(),
      id: "a0000001-0000-4000-a000-000000000001",
      agentId: "c0000000-0000-4000-a000-000000000001",
      name: "morning-briefing",
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "Summarize yesterday's threads",
      description: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      userId: "test-user-123",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
    {
      ...scheduleDefaults(),
      id: "a0000001-0000-4000-a000-000000000002",
      agentId: "c0000000-0000-4000-a000-000000000001",
      name: "check-inbox",
      triggerType: "loop",
      cronExpression: null,
      atTime: null,
      intervalSeconds: 900,
      timezone: "UTC",
      prompt: "Check inbox for urgent items",
      description: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      userId: "test-user-123",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
    {
      ...scheduleDefaults(),
      id: "a0000001-0000-4000-a000-000000000003",
      agentId: "a0000001-0000-4000-a000-000000000020",
      name: "other-schedule",
      triggerType: "cron",
      cronExpression: "0 12 * * *",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "This belongs to another agent",
      description: null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      userId: "test-user-123",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
    },
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
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.prompt).toBe("Summarize yesterday's threads");
      expect(entries[1]?.prompt).toBe("Check inbox for urgent items");
    });

    it("should convert cron schedule to display string", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every weekday at 9:00 AM");
    });

    it("should convert loop schedule to display string", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[1]?.time).toBe("Every 15 minutes");
    });

    it("should handle empty response", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(0);
    });

    it("should propagate API errors", async () => {
      // The background bootstrap also hits GET /api/zero/schedules via
      // fetchAllOrgSchedules$. Use a request counter so the first call
      // (bootstrap) succeeds and the second call (explicit test) gets 500.
      let requestCount = 0;
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          requestCount++;
          if (requestCount > 1) {
            return HttpResponse.json(
              {
                error: {
                  message: "Internal server error",
                  code: "INTERNAL_SERVER_ERROR",
                },
              },
              { status: 500 },
            );
          }
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();

      await expect(
        context.store.set(fetchZeroSchedules$, context.signal),
      ).rejects.toThrow("Internal server error");
    });
  });

  describe("saveZeroSchedule$", () => {
    it("should POST a cron schedule and refresh the list", async () => {
      const captured: { body: Record<string, unknown> | null } = { body: null };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

    it("should throw on API error during save", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(
            { error: { message: "Invalid timezone", code: "BAD_REQUEST" } },
            { status: 400 },
          );
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          async ({ params, request }) => {
            captured.action = params["action"] as string;
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          ({ params }) => {
            captured.action = params["action"] as string;
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          () => {
            return HttpResponse.json(
              { error: { message: "Schedule not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
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
        http.get("http://localhost:3000/api/zero/schedules", () => {
          fetchCount++;
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          () => {
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
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
        http.post(
          "http://localhost:3000/api/zero/schedules/run",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                runId: "run-abc-123",
                status: "running",
                createdAt: "2026-03-10T00:00:00Z",
              },
              { status: 201 },
            );
          },
        ),
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
        http.post("http://localhost:3000/api/zero/schedules/run", () => {
          return HttpResponse.json(
            { error: { message: "Schedule not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await setup();
      await expect(
        context.store.set(runScheduleNow$, "nonexistent-id", context.signal),
      ).rejects.toThrow("Schedule not found");
    });

    it("should throw on conflict when previous run is active", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/schedules/run", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Previous run is still active",
                code: "CONFLICT",
              },
            },
            { status: 409 },
          );
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
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                ...scheduleDefaults(),
                id: "b0000000-0000-4000-a000-000000000001",
                agentId: "c0000000-0000-4000-a000-000000000001",
                name: "one-time",
                triggerType: "once",
                cronExpression: null,
                atTime: "2026-06-15T14:30:00.000Z",
                intervalSeconds: null,
                timezone: "UTC",
                prompt: "One-time task",
                description: null,
                enabled: true,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.time).toMatch(/^Once on 2026-06-15 at/);
    });

    it("should convert daily cron to display string", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                ...scheduleDefaults(),
                id: "b0000000-0000-4000-a000-000000000002",
                agentId: "c0000000-0000-4000-a000-000000000001",
                name: "daily",
                triggerType: "cron",
                cronExpression: "0 14 * * *",
                atTime: null,
                intervalSeconds: null,
                timezone: "UTC",
                prompt: "Daily task",
                description: null,
                enabled: true,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every day at 2:00 PM");
    });

    it("should convert monthly cron to display string", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                ...scheduleDefaults(),
                id: "b0000000-0000-4000-a000-000000000003",
                agentId: "c0000000-0000-4000-a000-000000000001",
                name: "monthly",
                triggerType: "cron",
                cronExpression: "0 9 15 * *",
                atTime: null,
                intervalSeconds: null,
                timezone: "UTC",
                prompt: "Monthly task",
                description: null,
                enabled: true,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every month on day 15 at 9:00 AM");
    });

    it("should convert weekly cron to display string with day name", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                ...scheduleDefaults(),
                id: "b0000000-0000-4000-a000-000000000004",
                agentId: "c0000000-0000-4000-a000-000000000001",
                name: "weekly",
                triggerType: "cron",
                cronExpression: "0 10 * * 3",
                atTime: null,
                intervalSeconds: null,
                timezone: "UTC",
                prompt: "Weekly task",
                description: null,
                enabled: true,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$, context.signal);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries[0]?.time).toBe("Every week on Wednesday at 10:00 AM");
    });

    it("should include description in entries", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              {
                ...scheduleDefaults(),
                id: "b0000000-0000-4000-a000-000000000005",
                agentId: "c0000000-0000-4000-a000-000000000001",
                name: "described",
                triggerType: "cron",
                cronExpression: "0 9 * * *",
                atTime: null,
                intervalSeconds: null,
                timezone: "UTC",
                prompt: "Task with description",
                description: "A detailed description",
                enabled: true,
                nextRunAt: null,
                lastRunAt: null,
                createdAt: "2026-03-01T00:00:00Z",
                updatedAt: "2026-03-01T00:00:00Z",
              },
            ],
          });
        }),
      );

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

      server.use(
        http.delete(
          "http://localhost:3000/api/zero/schedules/:name",
          ({ params, request }) => {
            deletedName = params["name"] as string;
            const url = new URL(request.url);
            deletedAgentId = url.searchParams.get("agentId");
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
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
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
      );

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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ...mockDeployResponse(),
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ...mockDeployResponse(),
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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
  });

  describe("toggleOrgScheduleEnabled$", () => {
    it("should send agentId in toggle request body", async () => {
      const captured: {
        action: string | null;
        body: Record<string, unknown> | null;
      } = { action: null, body: null };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          async ({ params, request }) => {
            captured.action = params["action"] as string;
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
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

      server.use(
        http.delete(
          "http://localhost:3000/api/zero/schedules/:name",
          ({ params, request }) => {
            deletedName = params["name"] as string;
            const url = new URL(request.url);
            deletedAgentId = url.searchParams.get("agentId");
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
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
