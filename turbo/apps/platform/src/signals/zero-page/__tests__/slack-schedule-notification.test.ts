import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { slackOrgData$, initSlackOrg$ } from "../zero-slack.ts";
import { slackChannels$, fetchSlackChannels$ } from "../slack-channels.ts";
import {
  setAddScheduleOpen$,
  setEditingScheduleId$,
} from "../schedule-card.ts";
import {
  allOrgScheduleEntries$,
  fetchAllOrgSchedules$,
  saveOrgSchedule$,
} from "../zero-schedule.ts";

const context = testContext();

function createMockScheduleWithSlack(overrides?: {
  notifySlackChannelId?: string | null;
  notifySlack?: boolean;
}) {
  return {
    id: "e0000000-0000-4000-a000-000000000001",
    agentId: "e0000000-0000-4000-a000-000000000010",
    orgSlug: "test",
    userId: "test-user-123",
    displayName: null,
    name: "slack-schedule",
    triggerType: "cron",
    cronExpression: "0 9 * * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Daily standup",
    description: null,
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    artifactName: null,
    artifactVersion: null,
    volumeVersions: null,
    enabled: true,
    notifyEmail: false,
    notifySlack: overrides?.notifySlack ?? true,
    notifySlackChannelId: overrides?.notifySlackChannelId ?? null,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function mockDeployScheduleResponse() {
  const sched = createMockScheduleWithSlack();
  return { schedule: sched, created: true };
}

describe("slack schedule notification signals", () => {
  async function setup(path = "/schedule") {
    await setupPage({
      context,
      path,
      withoutRender: true,
    });
  }

  describe("fetchSlackChannels$", () => {
    it("should fetch channels when slack is installed", async () => {
      await setup();
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels.length).toBeGreaterThan(0);
      expect(channels[0]).toStrictEqual({ id: "C-GENERAL", name: "general" });
    });

    it("should return empty when slack channels API fails", async () => {
      server.use(
        http.get("*/api/zero/slack/channels", () => {
          return HttpResponse.json(
            { error: { message: "No Slack installation", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await setup();
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("dialog open triggers fetchSlackChannels$", () => {
    it("should fetch channels when add schedule dialog opens", async () => {
      await setup();
      await context.store.set(setAddScheduleOpen$, true, context.signal);
      // wait for the async fetch triggered by dialog open
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels.length).toBeGreaterThan(0);
    });

    it("should fetch channels when edit schedule dialog opens", async () => {
      await setup();
      await context.store.set(setEditingScheduleId$, "sched-1", context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels.length).toBeGreaterThan(0);
    });
  });

  describe("notifySlackChannelId in schedule entries", () => {
    it("should map notifySlackChannelId from API response", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              createMockScheduleWithSlack({ notifySlackChannelId: "C-ALERTS" }),
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchAllOrgSchedules$, context.signal);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.notifySlackChannelId).toBe("C-ALERTS");
      expect(entries[0]?.notifySlack).toBeTruthy();
    });

    it("should map null notifySlackChannelId for DM notifications", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              createMockScheduleWithSlack({
                notifySlack: true,
                notifySlackChannelId: null,
              }),
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchAllOrgSchedules$, context.signal);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries[0]?.notifySlack).toBeTruthy();
      expect(entries[0]?.notifySlackChannelId).toBeNull();
    });
  });

  describe("/schedule page — slack bot token present", () => {
    it("should have slackOrgData$ installed and fetch channels on dialog open", async () => {
      await setup("/schedule");
      await context.store.set(initSlackOrg$, context.signal);

      const data = await context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data!.isInstalled).toBeTruthy();

      await context.store.set(setAddScheduleOpen$, true, context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
      expect(channels[0]).toStrictEqual({ id: "C-GENERAL", name: "general" });
      expect(channels[1]).toStrictEqual({ id: "C-ALERTS", name: "alerts" });
    });

    it("should fetch channels when edit dialog opens", async () => {
      await setup("/schedule");

      await context.store.set(setEditingScheduleId$, "sched-1", context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
    });
  });

  describe("/schedule page — installed but user not connected", () => {
    it("should have isInstalled true but isConnected false", async () => {
      server.use(
        http.get("*/api/zero/integrations/slack", () => {
          return HttpResponse.json({
            isConnected: false,
            isInstalled: true,
            workspaceName: "Test Workspace",
            isAdmin: false,
            installUrl: null,
            connectUrl: "https://example.com/connect",
            defaultAgentName: null,
            agentOrgSlug: null,
            environment: {
              requiredSecrets: [],
              requiredVars: [],
              missingSecrets: [],
              missingVars: [],
            },
          });
        }),
      );

      await setup("/schedule");
      await context.store.set(initSlackOrg$, context.signal);

      const data = await context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data!.isInstalled).toBeTruthy();
      expect(data!.isConnected).toBeFalsy();
    });
  });

  describe("/schedule page — no slack installation", () => {
    it("should show not installed and return empty channels", async () => {
      server.use(
        http.get("*/api/zero/integrations/slack", () => {
          return HttpResponse.json({
            isConnected: false,
            isInstalled: false,
            workspaceName: null,
            isAdmin: false,
            defaultAgentName: null,
            agentOrgSlug: null,
            environment: {
              requiredSecrets: [],
              requiredVars: [],
              missingSecrets: [],
              missingVars: [],
            },
          });
        }),
        http.get("*/api/zero/slack/channels", () => {
          return HttpResponse.json(
            { error: { message: "No Slack installation", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await setup("/schedule");
      await context.store.set(initSlackOrg$, context.signal);

      const data = await context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data!.isInstalled).toBeFalsy();

      await context.store.set(setAddScheduleOpen$, true, context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("/team/:name page — slack bot token present", () => {
    it("should have slackOrgData$ installed and fetch channels on dialog open", async () => {
      await setup("/team/zero");

      const data = await context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data!.isInstalled).toBeTruthy();

      await context.store.set(setAddScheduleOpen$, true, context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
      expect(channels[0]).toStrictEqual({ id: "C-GENERAL", name: "general" });
    });

    it("should fetch channels when edit dialog opens", async () => {
      await setup("/team/zero");

      await context.store.set(setEditingScheduleId$, "sched-1", context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
    });
  });

  describe("/team/:name page — no slack installation", () => {
    it("should show not installed and return empty channels", async () => {
      server.use(
        http.get("*/api/zero/integrations/slack", () => {
          return HttpResponse.json({
            isConnected: false,
            isInstalled: false,
            workspaceName: null,
            isAdmin: false,
            defaultAgentName: null,
            agentOrgSlug: null,
            environment: {
              requiredSecrets: [],
              requiredVars: [],
              missingSecrets: [],
              missingVars: [],
            },
          });
        }),
        http.get("*/api/zero/slack/channels", () => {
          return HttpResponse.json(
            { error: { message: "No Slack installation", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await setup("/team/zero");

      const data = await context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data!.isInstalled).toBeFalsy();

      await context.store.set(setAddScheduleOpen$, true, context.signal);
      await context.store.set(fetchSlackChannels$, context.signal);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("saveOrgSchedule$ with notifySlackChannelId", () => {
    it("should send notifySlackChannelId in POST body", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ...mockDeployScheduleResponse(),
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
          prompt: "Post to channel",
          freq: "every_day",
          date: "2030-01-01",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          agentId: "e0000000-0000-4000-a000-000000000010",
          notifySlack: true,
          notifySlackChannelId: "C-ALERTS",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.notifySlack).toBeTruthy();
      expect(captured.body?.notifySlackChannelId).toBe("C-ALERTS");
    });

    it("should send null notifySlackChannelId for DM", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ...mockDeployScheduleResponse(),
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
          prompt: "DM notification",
          freq: "every_day",
          date: "2030-01-01",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          agentId: "e0000000-0000-4000-a000-000000000010",
          notifySlack: true,
          notifySlackChannelId: null,
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body?.notifySlack).toBeTruthy();
      expect(captured.body?.notifySlackChannelId).toBeNull();
    });

    it("should omit notifySlackChannelId when not provided", async () => {
      const captured: { body: Record<string, unknown> | null } = {
        body: null,
      };

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            captured.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ...mockDeployScheduleResponse(),
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
          prompt: "No slack",
          freq: "every_day",
          date: "2030-01-01",
          hour: 9,
          minute: 0,
          timezone: "UTC",
          intervalSeconds: 0,
          agentId: "e0000000-0000-4000-a000-000000000010",
        },
        context.signal,
      );

      expect(captured.body).not.toBeNull();
      expect(captured.body).not.toHaveProperty("notifySlackChannelId");
    });
  });
});
