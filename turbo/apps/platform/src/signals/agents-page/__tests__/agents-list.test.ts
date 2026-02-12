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
        http.get("http://localhost:3000/api/agent/required-env", () => {
          return HttpResponse.json({
            agents: [
              {
                composeId: "c1",
                agentName: "agent-1",
                requiredSecrets: ["MY_API_KEY"],
                requiredVariables: [],
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({ connectors: [] });
        }),
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
        http.get("http://localhost:3000/api/agent/required-env", () => {
          return HttpResponse.json({
            agents: [
              {
                composeId: "c1",
                agentName: "agent-1",
                requiredSecrets: [],
                requiredVariables: ["MY_VAR"],
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({ connectors: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);

      expect(items).toHaveLength(1);
      expect(items[0]!.missingSecrets).toStrictEqual([]);
      expect(items[0]!.missingVariables).toStrictEqual(["MY_VAR"]);
    });

    it("should exclude secrets provided by connected connectors", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/required-env", () => {
          return HttpResponse.json({
            agents: [
              {
                composeId: "c1",
                agentName: "agent-1",
                requiredSecrets: ["GITHUB_TOKEN", "MY_API_KEY"],
                requiredVariables: [],
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "conn-1",
                type: "github",
                authMethod: "oauth",
                externalId: null,
                externalUsername: null,
                externalEmail: null,
                oauthScopes: null,
                createdAt: "2024-01-01",
                updatedAt: "2024-01-01",
              },
            ],
          });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);
      const agent = items.find((a) => a.agentName === "agent-1");

      expect(agent).toBeDefined();
      // GITHUB_TOKEN excluded because GitHub connector is connected
      expect(agent!.missingSecrets).toStrictEqual(["MY_API_KEY"]);
    });

    it("should exclude already-configured secrets and variables", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/required-env", () => {
          return HttpResponse.json({
            agents: [
              {
                composeId: "c1",
                agentName: "agent-1",
                requiredSecrets: ["MY_API_KEY", "OTHER_KEY"],
                requiredVariables: ["MY_VAR", "OTHER_VAR"],
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "s1",
                name: "MY_API_KEY",
                type: "user",
                description: null,
                createdAt: "2024-01-01",
                updatedAt: "2024-01-01",
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/variables", () => {
          return HttpResponse.json({
            variables: [
              {
                id: "v1",
                name: "MY_VAR",
                value: "val",
                description: null,
                createdAt: "2024-01-01",
                updatedAt: "2024-01-01",
              },
            ],
          });
        }),
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({ connectors: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const items = await context.store.get(agentsMissingItems$);
      const agent = items.find((a) => a.agentName === "agent-1");

      expect(agent).toBeDefined();
      expect(agent!.missingSecrets).toStrictEqual(["OTHER_KEY"]);
      expect(agent!.missingVariables).toStrictEqual(["OTHER_VAR"]);
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
