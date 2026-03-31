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
  saveZeroJobSchedule$,
  deleteZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  setZeroJobEditedContent$,
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  discardZeroJobEdit$,
  buildZeroJobInstructions$,
  zeroJobBuilding$,
  zeroJobBuildError$,
  zeroJobUpdateSettings$,
  zeroJobSettingsSaving$,
  zeroJobAddedConnectors$,
  zeroJobConnectorsDirty$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  saveZeroJobConnectors$,
  discardZeroJobConnectors$,
  type ZeroJobScheduleSaveParams,
} from "../zero-job-detail";

const context = testContext();

function mockAgentResponse() {
  return {
    agentId: "c0000000-0000-4000-a000-000000000002",
    description: null,
    displayName: null,
    sound: null,
    avatarUrl: null,
    connectors: ["search"],
    firewallPolicies: null,
    customSkills: [],
  };
}

function mockInstructions() {
  return {
    content: "# Instructions\nDo the thing.",
    filename: "instructions.md",
  };
}

function scheduleBase() {
  return {
    displayName: null,
    userId: "test-user-123",
    orgSlug: "test",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    artifactName: null,
    artifactVersion: null,
    volumeVersions: null,
    notifyEmail: false,
    notifySlack: false,
    notifySlackChannelId: null,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    updatedAt: "2024-06-01T00:00:00Z",
  };
}

function mockDeployScheduleResponse() {
  return {
    schedule: {
      ...scheduleBase(),
      id: "f0000000-0000-4000-a000-000000000099",
      agentId: "c0000000-0000-4000-a000-000000000002",
      name: "zero-new",
      enabled: true,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      atTime: null,
      intervalSeconds: null,
      timezone: "UTC",
      prompt: "New schedule",
      description: null,
      createdAt: "2024-06-01T00:00:00Z",
    },
    created: true,
  };
}

function mockScheduleResponse() {
  return {
    ...scheduleBase(),
    id: "f0000000-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000002",
    name: "daily-run",
    enabled: true,
    triggerType: "cron",
    cronExpression: "0 9 * * *",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Run the daily digest",
    description: "Daily digest summary",
    createdAt: "2024-06-01T00:00:00Z",
  };
}

function mockSchedules() {
  return {
    schedules: [
      {
        ...scheduleBase(),
        id: "f0000000-0000-4000-a000-000000000001",
        agentId: "c0000000-0000-4000-a000-000000000002",
        name: "daily-run",
        enabled: true,
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        atTime: null,
        intervalSeconds: null,
        timezone: "UTC",
        prompt: "Run the daily digest",
        description: "Daily digest summary",
        createdAt: "2024-06-01T00:00:00Z",
      },
      {
        ...scheduleBase(),
        id: "f0000000-0000-4000-a000-000000000002",
        agentId: "c0000000-0000-4000-a000-000000000003",
        name: "other-run",
        enabled: true,
        triggerType: "cron",
        cronExpression: "0 12 * * *",
        atTime: null,
        intervalSeconds: null,
        timezone: "UTC",
        prompt: "Something else",
        description: null,
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
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(agentResponse);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      const detail = context.store.get(zeroJobDetail$);
      const loading = context.store.get(zeroJobDetailLoading$);
      const error = context.store.get(zeroJobDetailError$);

      expect(detail).toStrictEqual(agentResponse);
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
      expect(entries[0]!.description).toBe("Daily digest summary");
      expect(scheduleError).toBeNull();
    });

    it("should set error state when detail API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/:name", () => {
          return HttpResponse.json(
            { error: { message: "Not Found", code: "NOT_FOUND" } },
            { status: 404, statusText: "Not Found" },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(
        fetchZeroJobData$,
        "missing-agent",
        context.signal,
      );

      const detail = context.store.get(zeroJobDetail$);
      const loading = context.store.get(zeroJobDetailLoading$);
      const error = context.store.get(zeroJobDetailError$);

      expect(detail).toBeNull();
      expect(loading).toBeFalsy();
      expect(error).toBe("Failed to fetch agent (404)");
    });

    it("should set instructions error when instructions API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Internal Server Error",
                  code: "INTERNAL_SERVER_ERROR",
                },
              },
              { status: 500, statusText: "Internal Server Error" },
            );
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      const instructions = context.store.get(zeroJobInstructions$);
      const instructionsError = context.store.get(zeroJobInstructionsError$);

      expect(instructions).toBeNull();
      expect(instructionsError).toBe("Failed to fetch instructions (500)");

      // Detail should still succeed
      expect(context.store.get(zeroJobDetail$)).not.toBeNull();
    });

    it("should set schedule error when schedules API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(
            { error: { message: "Forbidden", code: "FORBIDDEN" } },
            { status: 403, statusText: "Forbidden" },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      const entries = await context.store.get(zeroJobScheduleEntries$);
      const scheduleError = context.store.get(zeroJobScheduleError$);

      expect(entries).toStrictEqual([]);
      expect(scheduleError).toBe("Failed to fetch schedules (403)");

      // Detail and instructions should still succeed
      expect(context.store.get(zeroJobDetail$)).not.toBeNull();
      expect(context.store.get(zeroJobInstructions$)).not.toBeNull();
    });

    it("should pass agent name directly to API", async () => {
      let capturedUrl = "";
      server.use(
        http.get("http://localhost:3000/api/zero/agents/*", ({ request }) => {
          capturedUrl = request.url;
          // Only match the agent detail request, not the instructions sub-path
          if (capturedUrl.includes("/instructions")) {
            return HttpResponse.json(mockInstructions());
          }
          return HttpResponse.json({
            ...mockAgentResponse(),
            name: "sub-agent",
          });
        }),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(
        fetchZeroJobData$,
        "my-org/sub-agent",
        context.signal,
      );

      const detail = context.store.get(zeroJobDetail$);
      expect(detail).not.toBeNull();
      // Verify the agent name was included in the URL (percent-encoded)
      expect(capturedUrl).toContain("my-org");
      expect(capturedUrl).toContain("sub-agent");
    });
  });

  describe("saveZeroJobSchedule$", () => {
    async function setupWithAgent() {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);
    }

    it("should save a cron schedule with every_day frequency", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      const params: ZeroJobScheduleSaveParams = {
        prompt: "Run daily task",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 30,
        timezone: "UTC",
        intervalSeconds: 0,
      };

      await context.store.set(saveZeroJobSchedule$, params, context.signal);

      expect(capturedBody).toMatchObject({
        agentId: "c0000000-0000-4000-a000-000000000002",
        timezone: "UTC",
        prompt: "Run daily task",
        enabled: true,
        cronExpression: "30 9 * * *",
      });
      expect(capturedBody).not.toHaveProperty("composeId");
    });

    it("should include description in save request when provided", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      const params: ZeroJobScheduleSaveParams = {
        prompt: "Run daily task",
        description: "  A daily task description  ",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 30,
        timezone: "UTC",
        intervalSeconds: 0,
      };

      await context.store.set(saveZeroJobSchedule$, params, context.signal);

      expect(capturedBody).toMatchObject({
        prompt: "Run daily task",
        description: "A daily task description",
      });
    });

    it("should omit description from save request when not provided", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      const params: ZeroJobScheduleSaveParams = {
        prompt: "Run daily task",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 30,
        timezone: "UTC",
        intervalSeconds: 0,
      };

      await context.store.set(saveZeroJobSchedule$, params, context.signal);

      expect(capturedBody).not.toHaveProperty("description");
    });

    it("should save a loop schedule with intervalSeconds", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockDeployScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      const params: ZeroJobScheduleSaveParams = {
        prompt: "Poll every 5 min",
        freq: "every_n_minutes",
        date: "2030-01-01",
        hour: 0,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 300,
      };

      await context.store.set(saveZeroJobSchedule$, params, context.signal);

      expect(capturedBody).toMatchObject({
        agentId: "c0000000-0000-4000-a000-000000000002",
        prompt: "Poll every 5 min",
        intervalSeconds: 300,
      });
      expect(capturedBody).not.toHaveProperty("cronExpression");
      expect(capturedBody).not.toHaveProperty("atTime");
      expect(capturedBody).not.toHaveProperty("composeId");
    });

    it("should throw for save when API returns error", async () => {
      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Quota exceeded",
                code: "INTERNAL_SERVER_ERROR",
              },
            },
            { status: 429, statusText: "Too Many Requests" },
          );
        }),
      );

      const params: ZeroJobScheduleSaveParams = {
        prompt: "Task",
        freq: "every_day",
        date: "2030-01-01",
        hour: 9,
        minute: 0,
        timezone: "UTC",
        intervalSeconds: 0,
      };

      await expect(
        context.store.set(saveZeroJobSchedule$, params, context.signal),
      ).rejects.toThrow("Save failed (429)");
    });
  });

  describe("deleteZeroJobSchedule$", () => {
    it("should send DELETE request with correct URL", async () => {
      let capturedUrl = "";

      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      server.use(
        http.delete(
          "http://localhost:3000/api/zero/schedules/:name",
          ({ request }) => {
            capturedUrl = request.url;
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await context.store.set(
        deleteZeroJobSchedule$,
        "daily-run",
        context.signal,
      );

      expect(capturedUrl).toContain("/api/zero/schedules/daily-run");
      expect(capturedUrl).toContain(
        "agentId=c0000000-0000-4000-a000-000000000002",
      );

      const entries = await context.store.get(zeroJobScheduleEntries$);
      expect(entries).toStrictEqual([]);
    });

    it("should throw when delete API returns error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      server.use(
        http.delete("http://localhost:3000/api/zero/schedules/:name", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "INTERNAL_SERVER_ERROR" } },
            { status: 404, statusText: "Not Found" },
          );
        }),
      );

      await expect(
        context.store.set(
          deleteZeroJobSchedule$,
          "nonexistent",
          context.signal,
        ),
      ).rejects.toThrow("Delete failed: Not found");
    });
  });

  describe("toggleZeroJobScheduleEnabled$", () => {
    it("should send enable request with agentId in body", async () => {
      let capturedUrl = "";
      let capturedBody: Record<string, unknown> | null = null;

      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          async ({ request }) => {
            capturedUrl = request.url;
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await context.store.set(
        toggleZeroJobScheduleEnabled$,
        {
          name: "daily-run",
          enabled: true,
        },
        context.signal,
      );

      expect(capturedUrl).toContain("/api/zero/schedules/daily-run/enable");
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!["agentId"]).toBe(
        "c0000000-0000-4000-a000-000000000002",
      );
      expect(capturedBody).not.toHaveProperty("composeId");
    });

    it("should send disable request for a schedule", async () => {
      let capturedUrl = "";

      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          ({ request }) => {
            capturedUrl = request.url;
            return HttpResponse.json(mockScheduleResponse());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await context.store.set(
        toggleZeroJobScheduleEnabled$,
        {
          name: "daily-run",
          enabled: false,
        },
        context.signal,
      );

      expect(capturedUrl).toContain("/api/zero/schedules/daily-run/disable");
    });

    it("should show toast error when toggle API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);

      server.use(
        http.post(
          "http://localhost:3000/api/zero/schedules/:name/:action",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Server error",
                  code: "INTERNAL_SERVER_ERROR",
                },
              },
              { status: 500, statusText: "Internal Server Error" },
            );
          },
        ),
      );

      await expect(
        context.store.set(
          toggleZeroJobScheduleEnabled$,
          {
            name: "daily-run",
            enabled: true,
          },
          context.signal,
        ),
      ).rejects.toThrow("Failed to enable schedule (500)");
    });
  });

  describe("instructions editing", () => {
    async function setupWithAgent() {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);
    }

    it("should track edited content and dirty state", async () => {
      await setupWithAgent();

      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      expect(context.store.get(zeroJobInstructionsDirty$)).toBeFalsy();

      context.store.set(setZeroJobEditedContent$, "New instructions");

      expect(context.store.get(zeroJobEditedContent$)).toBe("New instructions");
      expect(context.store.get(zeroJobInstructionsDirty$)).toBeTruthy();
    });

    it("should reset edited content on discard", async () => {
      await setupWithAgent();

      context.store.set(setZeroJobEditedContent$, "New instructions");
      expect(context.store.get(zeroJobInstructionsDirty$)).toBeTruthy();

      context.store.set(discardZeroJobEdit$);

      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      expect(context.store.get(zeroJobInstructionsDirty$)).toBeFalsy();
    });

    it("should build instructions via zero agents api and update state", async () => {
      let capturedBody: { content: string } | null = null;

      await setupWithAgent();

      server.use(
        http.put(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          async ({ request }) => {
            capturedBody = (await request.json()) as { content: string };
            return HttpResponse.json({
              agentId: "c0000000-0000-4000-a000-000000000002",
              description: null,
              displayName: null,
              sound: null,
              avatarUrl: null,
              connectors: [],
              firewallPolicies: null,
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
      );

      context.store.set(setZeroJobEditedContent$, "Updated instructions");
      await context.store.set(buildZeroJobInstructions$, context.signal);

      // Build should succeed without errors
      expect(context.store.get(zeroJobBuildError$)).toBeNull();

      // Should have sent the edited content via zero agents instructions API
      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.content).toBe("Updated instructions");

      // After build, edited content should be cleared
      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      expect(context.store.get(zeroJobBuilding$)).toBeFalsy();
      expect(context.store.get(zeroJobBuildError$)).toBeNull();

      // Instructions state should be optimistically updated
      const instructions = context.store.get(zeroJobInstructions$);
      expect(instructions?.content).toBe("Updated instructions");
    });

    it("should set build error on api failure", async () => {
      await setupWithAgent();

      server.use(
        http.put(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Build quota exceeded",
                  code: "INTERNAL_SERVER_ERROR",
                },
              },
              { status: 429, statusText: "Too Many Requests" },
            );
          },
        ),
      );

      context.store.set(setZeroJobEditedContent$, "Updated instructions");
      await context.store.set(buildZeroJobInstructions$, context.signal);

      expect(context.store.get(zeroJobBuilding$)).toBeFalsy();
      expect(context.store.get(zeroJobBuildError$)).toBe(
        "Failed to build instructions. Please try again.",
      );

      // Edited content should NOT be cleared on failure
      expect(context.store.get(zeroJobEditedContent$)).toBe(
        "Updated instructions",
      );
    });

    it("should not build when no edited content", async () => {
      let apiCalled = false;

      await setupWithAgent();

      server.use(
        http.put(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            apiCalled = true;
            return HttpResponse.json({
              agentId: "c0000000-0000-4000-a000-000000000002",
              description: null,
              displayName: null,
              sound: null,
              avatarUrl: null,
              connectors: [],
              firewallPolicies: null,
            });
          },
        ),
      );

      await context.store.set(buildZeroJobInstructions$, context.signal);
      expect(apiCalled).toBeFalsy();
    });
  });

  describe("zeroJobUpdateSettings$", () => {
    async function setupWithAgent() {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);
    }

    it("should update settings via PATCH agents API and refetch", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.patch(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              agentId: "c0000000-0000-4000-a000-000000000002",
              displayName: "New Name",
              description: null,
              sound: "friendly",
              avatarUrl: null,
              connectors: [],
              firewallPolicies: null,
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
      );

      await context.store.set(
        zeroJobUpdateSettings$,
        {
          displayName: "New Name",
          sound: "friendly",
        },
        context.signal,
      );

      // Should have sent the update fields directly to the agents PATCH endpoint
      expect(capturedBody["displayName"]).toBe("New Name");
      expect(capturedBody["sound"]).toBe("friendly");

      // Saving state should be reset
      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });

    it("should send empty update via PATCH agents API", async () => {
      let patchCalled = false;

      await setupWithAgent();

      server.use(
        http.patch(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002",
          () => {
            patchCalled = true;
            return HttpResponse.json({
              agentId: "c0000000-0000-4000-a000-000000000002",
              displayName: null,
              description: null,
              sound: null,
              avatarUrl: null,
              connectors: [],
              firewallPolicies: null,
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
      );

      await context.store.set(zeroJobUpdateSettings$, {}, context.signal);

      // The PATCH is always sent — idempotency is handled server-side
      expect(patchCalled).toBeTruthy();
      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });

    it("should show error toast on PATCH failure", async () => {
      await setupWithAgent();

      server.use(
        http.patch(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002",
          () => {
            return new HttpResponse("Internal error", { status: 500 });
          },
        ),
      );

      // Should not throw — errors are caught and shown via toast
      await context.store.set(
        zeroJobUpdateSettings$,
        {
          displayName: "New Name",
        },
        context.signal,
      );

      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });
  });

  describe("connectors management", () => {
    async function setupWithAgent() {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
        http.get("http://localhost:3000/api/zero/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent", context.signal);
    }

    it("should seed connectors from agent response", async () => {
      await setupWithAgent();

      const connectors = context.store.get(zeroJobAddedConnectors$);
      // Server filters out seed skills, only user connectors remain
      expect(connectors).toStrictEqual(["search"]);
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeFalsy();
    });

    it("should add and remove connectors with dirty tracking", async () => {
      await setupWithAgent();

      context.store.set(addZeroJobConnector$, "gmail");

      expect(context.store.get(zeroJobAddedConnectors$)).toStrictEqual([
        "search",
        "gmail",
      ]);
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeTruthy();

      context.store.set(removeZeroJobConnector$, "search");

      expect(context.store.get(zeroJobAddedConnectors$)).toStrictEqual([
        "gmail",
      ]);
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeTruthy();
    });

    it("should discard connector changes", async () => {
      await setupWithAgent();

      context.store.set(addZeroJobConnector$, "gmail");
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeTruthy();

      context.store.set(discardZeroJobConnectors$);

      expect(context.store.get(zeroJobAddedConnectors$)).toStrictEqual([
        "search",
      ]);
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeFalsy();
    });

    it("should save connectors via zero agents api", async () => {
      let capturedBody: { connectors: string[] } | null = null;

      await setupWithAgent();

      server.use(
        http.put(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002",
          async ({ request }) => {
            capturedBody = (await request.json()) as { connectors: string[] };
            return HttpResponse.json({
              agentId: "c0000000-0000-4000-a000-000000000002",
              description: null,
              displayName: null,
              sound: null,
              avatarUrl: null,
              connectors: capturedBody.connectors,
              firewallPolicies: null,
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
      );

      context.store.set(addZeroJobConnector$, "gmail");
      await context.store.set(saveZeroJobConnectors$, context.signal);

      // Verify connectors were sent as short names
      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.connectors).toStrictEqual(["search", "gmail"]);

      // After save, dirty state should be reset
      expect(context.store.get(zeroJobConnectorsDirty$)).toBeFalsy();
      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });

    it("should show error toast on save failure", async () => {
      await setupWithAgent();

      server.use(
        http.put(
          "http://localhost:3000/api/zero/agents/c0000000-0000-4000-a000-000000000002",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Build failed",
                  code: "INTERNAL_SERVER_ERROR",
                },
              },
              { status: 500, statusText: "Internal Server Error" },
            );
          },
        ),
      );

      context.store.set(addZeroJobConnector$, "gmail");

      // Should not throw — errors are caught and shown via toast
      await context.store.set(saveZeroJobConnectors$, context.signal);

      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });
  });
});
