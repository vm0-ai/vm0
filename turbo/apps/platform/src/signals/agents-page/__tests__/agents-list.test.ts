import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import {
  agentsList$,
  agentsLoading$,
  agentsError$,
  schedules$,
  agentsMissingItems$,
  reloadAgentsMissing$,
  fetchAgentsList$,
  getAgentScheduleStatus,
} from "../agents-list";

const context = testContext();

describe("agents-list signals", () => {
  describe("fetchAgentsList$", () => {
    it("should fetch agents and schedules successfully", async () => {
      const mockAgents = [
        { name: "agent-1", headVersionId: "v1", updatedAt: "2024-01-01" },
        { name: "agent-2", headVersionId: "v2", updatedAt: "2024-01-02" },
      ];
      const mockSchedules = [
        {
          name: "schedule-1",
          composeName: "agent-1",
          enabled: true,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      ];

      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json({ composes: mockAgents });
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json({ schedules: mockSchedules });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      await context.store.set(fetchAgentsList$);

      const agents = context.store.get(agentsList$);
      const schedules = context.store.get(schedules$);
      const loading = context.store.get(agentsLoading$);
      const error = context.store.get(agentsError$);

      expect(agents).toStrictEqual(mockAgents);
      expect(schedules).toStrictEqual(mockSchedules);
      expect(loading).toBeFalsy();
      expect(error).toBeNull();
    });

    it("should set error state when agents API fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json(
            { error: "Unauthorized" },
            { status: 401, statusText: "Unauthorized" },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      await context.store.set(fetchAgentsList$);

      const loading = context.store.get(agentsLoading$);
      const error = context.store.get(agentsError$);

      expect(loading).toBeFalsy();
      expect(error).toBe("Failed to fetch agents: Unauthorized");
    });

    it("should succeed even when schedules API fails", async () => {
      const mockAgents = [
        { name: "agent-1", headVersionId: "v1", updatedAt: "2024-01-01" },
      ];

      server.use(
        http.get("http://localhost:3000/api/agent/composes/list", () => {
          return HttpResponse.json({ composes: mockAgents });
        }),
        http.get("http://localhost:3000/api/agent/schedules", () => {
          return HttpResponse.json(
            { error: "Internal Server Error" },
            { status: 500 },
          );
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      await context.store.set(fetchAgentsList$);

      const agents = context.store.get(agentsList$);
      const schedules = context.store.get(schedules$);
      const loading = context.store.get(agentsLoading$);
      const error = context.store.get(agentsError$);

      expect(agents).toStrictEqual(mockAgents);
      expect(schedules).toStrictEqual([]);
      expect(loading).toBeFalsy();
      expect(error).toBeNull();
    });
  });

  describe("agentsMissingItems$", () => {
    it("should return missing secrets for agents", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/schedules/missing-secrets",
          () => {
            return HttpResponse.json({
              agents: [
                {
                  composeId: "c1",
                  agentName: "agent-1",
                  requiredSecrets: ["MY_API_KEY"],
                  missingSecrets: ["MY_API_KEY"],
                  requiredVariables: [],
                  missingVariables: [],
                },
              ],
            });
          },
        ),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);

      expect(items).toHaveLength(1);
      expect(items[0]!.agentName).toBe("agent-1");
      expect(items[0]!.missingSecrets).toStrictEqual(["MY_API_KEY"]);
      expect(items[0]!.missingVariables).toStrictEqual([]);
    });

    it("should return missing variables for agents", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/schedules/missing-secrets",
          () => {
            return HttpResponse.json({
              agents: [
                {
                  composeId: "c1",
                  agentName: "agent-1",
                  requiredSecrets: [],
                  missingSecrets: [],
                  requiredVariables: ["MY_VAR"],
                  missingVariables: ["MY_VAR"],
                },
              ],
            });
          },
        ),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);

      expect(items).toHaveLength(1);
      expect(items[0]!.missingSecrets).toStrictEqual([]);
      expect(items[0]!.missingVariables).toStrictEqual(["MY_VAR"]);
    });

    it("should return both missing secrets and variables", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/agent/schedules/missing-secrets",
          () => {
            return HttpResponse.json({
              agents: [
                {
                  composeId: "c1",
                  agentName: "agent-1",
                  requiredSecrets: ["GITHUB_TOKEN", "MY_API_KEY"],
                  missingSecrets: ["GITHUB_TOKEN", "MY_API_KEY"],
                  requiredVariables: ["MY_VAR"],
                  missingVariables: ["MY_VAR"],
                },
              ],
            });
          },
        ),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);

      expect(items).toHaveLength(1);
      expect(items[0]!.missingSecrets).toStrictEqual([
        "GITHUB_TOKEN",
        "MY_API_KEY",
      ]);
      expect(items[0]!.missingVariables).toStrictEqual(["MY_VAR"]);
    });

    it("should refresh after reloadAgentsMissing$ is triggered", async () => {
      let callCount = 0;

      server.use(
        http.get(
          "http://localhost:3000/api/agent/schedules/missing-secrets",
          () => {
            callCount++;
            if (callCount === 1) {
              return HttpResponse.json({
                agents: [
                  {
                    composeId: "c1",
                    agentName: "agent-1",
                    requiredSecrets: ["MY_API_KEY"],
                    missingSecrets: ["MY_API_KEY"],
                    requiredVariables: [],
                    missingVariables: [],
                  },
                ],
              });
            }
            // After secret is added, no more missing
            return HttpResponse.json({ agents: [] });
          },
        ),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      // First fetch returns missing secret
      const itemsBefore = await context.store.get(agentsMissingItems$);
      expect(itemsBefore).toHaveLength(1);

      // Trigger reload (simulating what happens after adding a secret)
      context.store.set(reloadAgentsMissing$);

      // Second fetch returns no missing items
      const itemsAfter = await context.store.get(agentsMissingItems$);
      expect(itemsAfter).toHaveLength(0);
      expect(callCount).toBe(2);
    });
  });

  describe("getAgentScheduleStatus", () => {
    it("should return true when agent has an enabled schedule", () => {
      const schedules = [
        {
          name: "schedule-1",
          composeName: "agent-1",
          enabled: true,
          timezone: "UTC",
        },
      ];

      expect(getAgentScheduleStatus("agent-1", schedules)).toBeTruthy();
    });

    it("should return false when agent has no schedule", () => {
      const schedules = [
        {
          name: "schedule-1",
          composeName: "agent-2",
          enabled: true,
          timezone: "UTC",
        },
      ];

      expect(getAgentScheduleStatus("agent-1", schedules)).toBeFalsy();
    });

    it("should return false when agent has only disabled schedules", () => {
      const schedules = [
        {
          name: "schedule-1",
          composeName: "agent-1",
          enabled: false,
          timezone: "UTC",
        },
      ];

      expect(getAgentScheduleStatus("agent-1", schedules)).toBeFalsy();
    });

    it("should return true when agent has at least one enabled schedule among multiple", () => {
      const schedules = [
        {
          name: "schedule-1",
          composeName: "agent-1",
          enabled: false,
          timezone: "UTC",
        },
        {
          name: "schedule-2",
          composeName: "agent-1",
          enabled: true,
          timezone: "UTC",
        },
      ];

      expect(getAgentScheduleStatus("agent-1", schedules)).toBeTruthy();
    });
  });
});
