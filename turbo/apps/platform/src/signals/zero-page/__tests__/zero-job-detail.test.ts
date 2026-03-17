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
  zeroJobAddedSkills$,
  zeroJobSkillsDirty$,
  addZeroJobSkill$,
  removeZeroJobSkill$,
  saveZeroJobSkills$,
  discardZeroJobSkills$,
  type ZeroJobScheduleSaveParams,
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
          framework: "claude-code",
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
      expect(error).toBe("Failed to fetch agent: Not Found (404)");
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

    it("should pass agent name directly to API", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get("name");

          expect(name).toBe("my-org/sub-agent");

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
    });
  });

  describe("saveZeroJobSchedule$", () => {
    async function setupWithAgent() {
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
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");
    }

    it("should save a cron schedule with every_day frequency", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/agent/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ id: "new-sched" });
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
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

      await context.store.set(saveZeroJobSchedule$, params);

      expect(capturedBody).toMatchObject({
        composeId: "compose-1",
        timezone: "UTC",
        prompt: "Run daily task",
        enabled: true,
        cronExpression: "30 9 * * *",
      });
    });

    it("should save a loop schedule with intervalSeconds", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/agent/schedules",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ id: "new-sched" });
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
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

      await context.store.set(saveZeroJobSchedule$, params);

      expect(capturedBody).toMatchObject({
        composeId: "compose-1",
        prompt: "Poll every 5 min",
        intervalSeconds: 300,
      });
      expect(capturedBody).not.toHaveProperty("cronExpression");
      expect(capturedBody).not.toHaveProperty("atTime");
    });

    it("should throw for save when API returns error", async () => {
      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            { error: { message: "Quota exceeded" } },
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
        context.store.set(saveZeroJobSchedule$, params),
      ).rejects.toThrow("Quota exceeded");
    });
  });

  describe("deleteZeroJobSchedule$", () => {
    it("should send DELETE request with correct URL", async () => {
      let capturedUrl = "";

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
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      server.use(
        http.delete(
          "http://localhost:3000/api/agent/schedules/:name",
          ({ request }) => {
            capturedUrl = request.url;
            return new HttpResponse(null, { status: 204 });
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await context.store.set(deleteZeroJobSchedule$, "daily-run");

      expect(capturedUrl).toContain("/api/agent/schedules/daily-run");
      expect(capturedUrl).toContain("composeId=compose-1");

      const entries = await context.store.get(zeroJobScheduleEntries$);
      expect(entries).toStrictEqual([]);
    });

    it("should throw when delete API returns error", async () => {
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
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      server.use(
        http.delete("http://localhost:3000/api/agent/schedules/:name", () => {
          return HttpResponse.json(
            { error: { message: "Not found" } },
            { status: 404, statusText: "Not Found" },
          );
        }),
      );

      await expect(
        context.store.set(deleteZeroJobSchedule$, "nonexistent"),
      ).rejects.toThrow("Not found");
    });
  });

  describe("toggleZeroJobScheduleEnabled$", () => {
    it("should send enable request for a schedule", async () => {
      let capturedUrl = "";

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
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      server.use(
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/:action",
          ({ request }) => {
            capturedUrl = request.url;
            return HttpResponse.json({ ok: true });
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await context.store.set(toggleZeroJobScheduleEnabled$, {
        name: "daily-run",
        enabled: true,
      });

      expect(capturedUrl).toContain("/api/agent/schedules/daily-run/enable");
    });

    it("should send disable request for a schedule", async () => {
      let capturedUrl = "";

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
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      server.use(
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/:action",
          ({ request }) => {
            capturedUrl = request.url;
            return HttpResponse.json({ ok: true });
          },
        ),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(mockSchedules());
        }),
      );

      await context.store.set(toggleZeroJobScheduleEnabled$, {
        name: "daily-run",
        enabled: false,
      });

      expect(capturedUrl).toContain("/api/agent/schedules/daily-run/disable");
    });

    it("should show toast error when toggle API fails", async () => {
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
          return HttpResponse.json(mockSchedules());
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");

      server.use(
        http.post(
          "http://localhost:3000/api/agent/schedules/:name/:action",
          () => {
            return HttpResponse.json(
              { error: { message: "Server error" } },
              { status: 500, statusText: "Internal Server Error" },
            );
          },
        ),
      );

      await expect(
        context.store.set(toggleZeroJobScheduleEnabled$, {
          name: "daily-run",
          enabled: true,
        }),
      ).rejects.toThrow("Server error");
    });
  });

  describe("instructions editing", () => {
    async function setupWithAgent() {
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
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");
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

    it("should build instructions via compose job and update state", async () => {
      let capturedJobBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post("*/api/compose/jobs", async ({ request }) => {
          capturedJobBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            jobId: "job-1",
            status: "completed",
            result: {
              composeId: "compose-1",
              composeName: "my-agent",
              versionId: "v2",
              warnings: [],
            },
          });
        }),
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
      );

      context.store.set(setZeroJobEditedContent$, "Updated instructions");
      await context.store.set(buildZeroJobInstructions$);

      // Build should succeed without errors
      expect(context.store.get(zeroJobBuildError$)).toBeNull();

      // Should have sent the edited content in the compose job
      expect(capturedJobBody).toHaveProperty("instructions");
      expect(capturedJobBody["instructions"]).toBe("Updated instructions");

      // After build, edited content should be cleared
      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      expect(context.store.get(zeroJobBuilding$)).toBeFalsy();
      expect(context.store.get(zeroJobBuildError$)).toBeNull();

      // Instructions state should be optimistically updated
      const instructions = context.store.get(zeroJobInstructions$);
      expect(instructions?.content).toBe("Updated instructions");
    });

    it("should set build error on compose job failure", async () => {
      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/compose/jobs", () => {
          return HttpResponse.json(
            { error: { message: "Build quota exceeded" } },
            { status: 429, statusText: "Too Many Requests" },
          );
        }),
      );

      context.store.set(setZeroJobEditedContent$, "Updated instructions");
      await context.store.set(buildZeroJobInstructions$);

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
      let composeJobCalled = false;

      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/compose/jobs", () => {
          composeJobCalled = true;
          return HttpResponse.json({ jobId: "job-1", status: "completed" });
        }),
      );

      await context.store.set(buildZeroJobInstructions$);
      expect(composeJobCalled).toBeFalsy();
    });
  });

  describe("zeroJobUpdateSettings$", () => {
    async function setupWithAgent() {
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
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");
    }

    it("should update settings via compose job and refetch", async () => {
      let capturedJobBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/compose/jobs",
          async ({ request }) => {
            capturedJobBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              jobId: "job-1",
              status: "completed",
              result: {
                composeId: "compose-1",
                composeName: "my-agent",
                versionId: "v2",
                warnings: [],
              },
            });
          },
        ),
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
      );

      await context.store.set(zeroJobUpdateSettings$, {
        displayName: "New Name",
        sound: "friendly",
      });

      // Should have sent updated content with new metadata
      const content = capturedJobBody["content"] as Record<string, unknown>;
      const agents = content["agents"] as Record<
        string,
        Record<string, unknown>
      >;
      const mainAgent = agents["main"];
      const metadata = mainAgent["metadata"] as Record<string, string>;
      expect(metadata["displayName"]).toBe("New Name");
      expect(metadata["sound"]).toBe("friendly");

      // Saving state should be reset
      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });

    it("should skip update when metadata has not changed", async () => {
      let composeJobCalled = false;

      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/compose/jobs", () => {
          composeJobCalled = true;
          return HttpResponse.json({ jobId: "job-1", status: "completed" });
        }),
      );

      // Default sound is "professional" (from extractAgentFields fallback)
      // and no displayName is set — pass same values
      await context.store.set(zeroJobUpdateSettings$, {});

      expect(composeJobCalled).toBeFalsy();
    });

    it("should show error toast on compose job failure", async () => {
      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/compose/jobs", () => {
          return HttpResponse.json(
            { error: { message: "Internal error" } },
            { status: 500, statusText: "Internal Server Error" },
          );
        }),
      );

      // Should not throw — errors are caught and shown via toast
      await context.store.set(zeroJobUpdateSettings$, {
        displayName: "New Name",
      });

      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });
  });

  describe("skills management", () => {
    async function setupWithAgent() {
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
          return HttpResponse.json({ schedules: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });
      await context.store.set(fetchZeroJobData$, "my-agent");
    }

    it("should seed skills from agent detail", async () => {
      await setupWithAgent();

      const skills = context.store.get(zeroJobAddedSkills$);
      // mockAgentResponse has skills: ["search"], skillUrlToValue returns the value as-is
      // since "search" doesn't start with the GitHub URL prefix
      expect(skills).toStrictEqual(["search"]);
      expect(context.store.get(zeroJobSkillsDirty$)).toBeFalsy();
    });

    it("should add and remove skills with dirty tracking", async () => {
      await setupWithAgent();

      context.store.set(addZeroJobSkill$, "gmail");

      expect(context.store.get(zeroJobAddedSkills$)).toStrictEqual([
        "search",
        "gmail",
      ]);
      expect(context.store.get(zeroJobSkillsDirty$)).toBeTruthy();

      context.store.set(removeZeroJobSkill$, "search");

      expect(context.store.get(zeroJobAddedSkills$)).toStrictEqual(["gmail"]);
      expect(context.store.get(zeroJobSkillsDirty$)).toBeTruthy();
    });

    it("should discard skill changes", async () => {
      await setupWithAgent();

      context.store.set(addZeroJobSkill$, "gmail");
      expect(context.store.get(zeroJobSkillsDirty$)).toBeTruthy();

      context.store.set(discardZeroJobSkills$);

      expect(context.store.get(zeroJobAddedSkills$)).toStrictEqual(["search"]);
      expect(context.store.get(zeroJobSkillsDirty$)).toBeFalsy();
    });

    it("should save skills via compose job", async () => {
      let capturedJobBody: Record<string, unknown> = {};

      await setupWithAgent();

      server.use(
        http.post(
          "http://localhost:3000/api/compose/jobs",
          async ({ request }) => {
            capturedJobBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              jobId: "job-1",
              status: "completed",
              result: {
                composeId: "compose-1",
                composeName: "my-agent",
                versionId: "v2",
                warnings: [],
              },
            });
          },
        ),
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(mockAgentResponse());
        }),
        http.get(
          "http://localhost:3000/api/agent/composes/compose-1/instructions",
          () => {
            return HttpResponse.json(mockInstructions());
          },
        ),
      );

      context.store.set(addZeroJobSkill$, "gmail");
      await context.store.set(saveZeroJobSkills$);

      // Verify skills were sent in the compose content
      const content = capturedJobBody["content"] as Record<string, unknown>;
      const agents = content["agents"] as Record<
        string,
        Record<string, unknown>
      >;
      const mainAgent = agents["main"];
      const skills = mainAgent["skills"] as string[];
      expect(skills).toHaveLength(2);
      // Skills should be converted to URLs via skillValueToUrl
      expect(skills[0]).toContain("search");
      expect(skills[1]).toContain("gmail");

      // After save, dirty state should be reset
      expect(context.store.get(zeroJobSkillsDirty$)).toBeFalsy();
      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });

    it("should show error toast on save failure", async () => {
      await setupWithAgent();

      server.use(
        http.post("http://localhost:3000/api/compose/jobs", () => {
          return HttpResponse.json(
            { error: { message: "Build failed" } },
            { status: 500, statusText: "Internal Server Error" },
          );
        }),
      );

      context.store.set(addZeroJobSkill$, "gmail");

      // Should not throw — errors are caught and shown via toast
      await context.store.set(saveZeroJobSkills$);

      expect(context.store.get(zeroJobSettingsSaving$)).toBeFalsy();
    });
  });
});
