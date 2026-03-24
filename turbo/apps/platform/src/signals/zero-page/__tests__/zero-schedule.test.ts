import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
} from "../zero-schedule.ts";

const context = testContext();

function createMockSchedules() {
  return [
    {
      id: "sched-1",
      zeroAgentId: "mock-compose-id",
      agentName: "zero",
      orgSlug: "test",
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
    },
    {
      id: "sched-2",
      zeroAgentId: "mock-compose-id",
      agentName: "zero",
      orgSlug: "test",
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
    },
    {
      id: "sched-other",
      zeroAgentId: "other-compose-id",
      agentName: "other-agent",
      orgSlug: "test",
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
    },
  ];
}

async function setup() {
  await setupPage({
    context,
    path: "/schedule",
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
      await context.store.set(fetchZeroSchedules$);

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
      await context.store.set(fetchZeroSchedules$);

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
      await context.store.set(fetchZeroSchedules$);

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
      await context.store.set(fetchZeroSchedules$);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(0);
    });

    it("should handle API error gracefully", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSchedules$);

      const entries = context.store.get(zeroScheduleEntries$);
      expect(entries).toHaveLength(0);
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
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(saveZeroSchedule$, {
        prompt: "Daily standup summary",
        freq: "every_day",
        date: "2026-03-15",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 900,
      });

      expect(captured.body).not.toBeNull();
      expect(captured.body?.zeroAgentId).toBe("mock-compose-id");
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
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(saveZeroSchedule$, {
        prompt: "Check inbox",
        freq: "every_n_minutes",
        date: "2026-03-15",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 900,
      });

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
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(saveZeroSchedule$, {
        prompt: "Updated prompt",
        freq: "every_weekday",
        date: "2026-03-15",
        hour: 10,
        minute: 30,
        timezone: "America/New_York",
        intervalSeconds: 900,
        editName: "existing-schedule",
      });

      expect(captured.body?.name).toBe("existing-schedule");
      expect(captured.body?.cronExpression).toBe("30 10 * * 1-5");
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
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(toggleZeroScheduleEnabled$, {
        name: "morning-briefing",
        enabled: true,
      });

      expect(captured.action).toBe("enable");
      expect(captured.body?.zeroAgentId).toBe("mock-compose-id");
    });

    it("should POST to disable endpoint when enabled is false", async () => {
      const captured: { action: string | null } = { action: null };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          ({ params }) => {
            captured.action = params["action"] as string;
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(toggleZeroScheduleEnabled$, {
        name: "morning-briefing",
        enabled: false,
      });

      expect(captured.action).toBe("disable");
    });

    it("should throw and show toast on API error", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          () => {
            return HttpResponse.json(
              { error: { message: "Schedule not found" } },
              { status: 404 },
            );
          },
        ),
      );

      await setup();
      await expect(
        context.store.set(toggleZeroScheduleEnabled$, {
          name: "nonexistent",
          enabled: true,
        }),
      ).rejects.toThrow("Schedule not found");
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
            deletedAgentId = url.searchParams.get("zeroAgentId");
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(deleteZeroSchedule$, "morning-briefing");

      expect(deletedName).toBe("morning-briefing");
      expect(deletedAgentId).toBe("mock-compose-id");
    });
  });
});

describe("org schedule signals", () => {
  async function setup() {
    await setupPage({
      context,
      path: "/schedule",
      withoutRender: true,
    });
  }

  describe("fetchAllOrgSchedules$ and allOrgScheduleEntries$", () => {
    it("should map zeroAgentId and agentName fields from API response", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: createMockSchedules() });
        }),
      );

      await setup();
      await context.store.set(fetchAllOrgSchedules$);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries).toHaveLength(3);

      const zeroEntry = entries.find((e) => e.name === "morning-briefing");
      expect(zeroEntry?.zeroAgentId).toBe("mock-compose-id");
      expect(zeroEntry?.agentName).toBe("zero");

      const otherEntry = entries.find((e) => e.name === "other-schedule");
      expect(otherEntry?.zeroAgentId).toBe("other-compose-id");
      expect(otherEntry?.agentName).toBe("other-agent");
    });
  });

  describe("saveOrgSchedule$", () => {
    it("should send zeroAgentId in POST body", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(saveOrgSchedule$, {
        prompt: "Org-wide daily task",
        freq: "every_day",
        date: "2030-01-01",
        hour: 8,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 0,
        zeroAgentId: "agent-uuid-123",
      });

      expect(captured.body).not.toBeNull();
      expect(captured.body?.zeroAgentId).toBe("agent-uuid-123");
      expect(captured.body).not.toHaveProperty("composeId");
      expect(captured.body?.prompt).toBe("Org-wide daily task");
      expect(captured.body?.cronExpression).toBe("0 8 * * *");
    });
  });

  describe("toggleOrgScheduleEnabled$", () => {
    it("should send zeroAgentId in toggle request body", async () => {
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
            return HttpResponse.json({ success: true });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(toggleOrgScheduleEnabled$, {
        name: "morning-briefing",
        enabled: false,
        zeroAgentId: "agent-uuid-123",
      });

      expect(captured.action).toBe("disable");
      expect(captured.body?.zeroAgentId).toBe("agent-uuid-123");
      expect(captured.body).not.toHaveProperty("composeId");
    });
  });

  describe("deleteOrgSchedule$", () => {
    it("should send zeroAgentId as query param in DELETE request", async () => {
      let deletedName: string | null = null;
      let deletedAgentId: string | null = null;

      server.use(
        http.delete(
          "http://localhost:3000/api/zero/schedules/:name",
          ({ params, request }) => {
            deletedName = params["name"] as string;
            const url = new URL(request.url);
            deletedAgentId = url.searchParams.get("zeroAgentId");
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setup();
      await context.store.set(deleteOrgSchedule$, {
        name: "morning-briefing",
        zeroAgentId: "agent-uuid-123",
      });

      expect(deletedName).toBe("morning-briefing");
      expect(deletedAgentId).toBe("agent-uuid-123");
    });
  });
});
