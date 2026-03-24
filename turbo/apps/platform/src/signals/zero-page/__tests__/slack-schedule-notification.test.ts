import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { slackOrgData$ } from "../zero-slack.ts";
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
  slackChannelId?: string | null;
  notifySlack?: boolean;
}) {
  return {
    id: "sched-slack-1",
    agentId: "agent-1",
    agentName: "zero",
    orgSlug: "test",
    name: "slack-schedule",
    triggerType: "cron",
    cronExpression: "0 9 * * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Daily standup",
    description: null,
    enabled: true,
    notifyEmail: false,
    notifySlack: overrides?.notifySlack ?? true,
    slackChannelId: overrides?.slackChannelId ?? null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

describe("slack schedule notification signals", () => {
  async function setup(path = "/schedule") {
    await setupPage({
      context,
      path,
      withoutRender: true,
    });
  }

  describe("slackOrgData$ initialization", () => {
    it("should be available on /schedule page", async () => {
      await setup("/schedule");

      const data = context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data?.isInstalled).toBeTruthy();
      expect(data?.isConnected).toBeTruthy();
    });

    it("should be available on /team/:name page", async () => {
      await setup("/team/zero");

      const data = context.store.get(slackOrgData$);
      expect(data).not.toBeNull();
      expect(data?.isInstalled).toBeTruthy();
    });
  });

  describe("fetchSlackChannels$", () => {
    it("should fetch channels when slack is installed", async () => {
      await setup();
      await context.store.set(fetchSlackChannels$);

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
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("dialog open triggers fetchSlackChannels$", () => {
    it("should fetch channels when add schedule dialog opens", async () => {
      await setup();
      context.store.set(setAddScheduleOpen$, true);
      // wait for the async fetch triggered by dialog open
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels.length).toBeGreaterThan(0);
    });

    it("should fetch channels when edit schedule dialog opens", async () => {
      await setup();
      context.store.set(setEditingScheduleId$, "sched-1");
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels.length).toBeGreaterThan(0);
    });
  });

  describe("slackChannelId in schedule entries", () => {
    it("should map slackChannelId from API response", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              createMockScheduleWithSlack({ slackChannelId: "C-ALERTS" }),
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchAllOrgSchedules$);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.slackChannelId).toBe("C-ALERTS");
      expect(entries[0]?.notifySlack).toBeTruthy();
    });

    it("should map null slackChannelId for DM notifications", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({
            schedules: [
              createMockScheduleWithSlack({
                notifySlack: true,
                slackChannelId: null,
              }),
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchAllOrgSchedules$);

      const entries = context.store.get(allOrgScheduleEntries$);
      expect(entries[0]?.notifySlack).toBeTruthy();
      expect(entries[0]?.slackChannelId).toBeNull();
    });
  });

  describe("/schedule page — slack bot token present", () => {
    it("should have slackOrgData$ installed and fetch channels on dialog open", async () => {
      await setup("/schedule");

      const data = context.store.get(slackOrgData$);
      expect(data?.isInstalled).toBeTruthy();

      context.store.set(setAddScheduleOpen$, true);
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
      expect(channels[0]).toStrictEqual({ id: "C-GENERAL", name: "general" });
      expect(channels[1]).toStrictEqual({ id: "C-ALERTS", name: "alerts" });
    });

    it("should fetch channels when edit dialog opens", async () => {
      await setup("/schedule");

      context.store.set(setEditingScheduleId$, "sched-1");
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
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

      const data = context.store.get(slackOrgData$);
      expect(data?.isInstalled).toBeFalsy();

      context.store.set(setAddScheduleOpen$, true);
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("/team/:name page — slack bot token present", () => {
    it("should have slackOrgData$ installed and fetch channels on dialog open", async () => {
      await setup("/team/zero");

      const data = context.store.get(slackOrgData$);
      expect(data?.isInstalled).toBeTruthy();

      context.store.set(setAddScheduleOpen$, true);
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(2);
      expect(channels[0]).toStrictEqual({ id: "C-GENERAL", name: "general" });
    });

    it("should fetch channels when edit dialog opens", async () => {
      await setup("/team/zero");

      context.store.set(setEditingScheduleId$, "sched-1");
      await context.store.set(fetchSlackChannels$);

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

      const data = context.store.get(slackOrgData$);
      expect(data?.isInstalled).toBeFalsy();

      context.store.set(setAddScheduleOpen$, true);
      await context.store.set(fetchSlackChannels$);

      const channels = context.store.get(slackChannels$);
      expect(channels).toHaveLength(0);
    });
  });

  describe("saveOrgSchedule$ with slackChannelId", () => {
    it("should send slackChannelId in POST body", async () => {
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
        prompt: "Post to channel",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 0,
        agentId: "agent-1",
        notifySlack: true,
        slackChannelId: "C-ALERTS",
      });

      expect(captured.body).not.toBeNull();
      expect(captured.body?.notifySlack).toBeTruthy();
      expect(captured.body?.slackChannelId).toBe("C-ALERTS");
    });

    it("should send null slackChannelId for DM", async () => {
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
        prompt: "DM notification",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 0,
        agentId: "agent-1",
        notifySlack: true,
        slackChannelId: null,
      });

      expect(captured.body).not.toBeNull();
      expect(captured.body?.notifySlack).toBeTruthy();
      expect(captured.body?.slackChannelId).toBeNull();
    });

    it("should omit slackChannelId when not provided", async () => {
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
        prompt: "No slack",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 0,
        agentId: "agent-1",
      });

      expect(captured.body).not.toBeNull();
      expect(captured.body).not.toHaveProperty("slackChannelId");
    });
  });
});
