import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../__tests__/test-helpers";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { detachedSetupPage } from "../../../__tests__/page-helper";
import {
  zeroJobDetail$,
  zeroJobInstructions$,
  zeroJobScheduleEntries$,
  setActiveAgent$,
  saveZeroJobSchedule$,
  deleteZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  setZeroJobEditedContent$,
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  discardZeroJobEdit$,
  buildZeroJobInstructions$,
  zeroJobUpdateSettings$,
  zeroJobAddedConnectors$,
  zeroJobConnectorsDirty$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  saveZeroJobConnectors$,
  discardZeroJobConnectors$,
  zeroJobPermissionPolicies$,
  type ZeroJobScheduleSaveParams,
} from "../zero-job-detail";

const context = testContext();
const mockApi = createMockApi(context);

function mockAgentResponse() {
  return {
    agentId: "c0000000-0000-4000-a000-000000000002",
    ownerId: "test-owner-id",
    description: null,
    displayName: null,
    sound: null,
    avatarUrl: null,
    permissionPolicies: null,
    customSkills: [],
    modelProviderId: null,
    selectedModel: null,
  };
}

function mockInstructions() {
  return {
    content: "# Instructions\nDo the thing.",
    filename: "instructions.md",
  };
}

function mockDeployScheduleResponse() {
  return {
    schedule: createMockScheduleResponse({
      id: "f0000000-0000-4000-a000-000000000099",
      agentId: "c0000000-0000-4000-a000-000000000002",
      name: "zero-new",
      cronExpression: "0 9 * * *",
      prompt: "New schedule",
      createdAt: "2024-06-01T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
    }),
    created: true,
  };
}

function mockScheduleResponse(): ScheduleResponse {
  return createMockScheduleResponse({
    id: "f0000000-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000002",
    name: "daily-run",
    cronExpression: "0 9 * * *",
    prompt: "Run the daily digest",
    description: "Daily digest summary",
    createdAt: "2024-06-01T00:00:00Z",
    updatedAt: "2024-06-01T00:00:00Z",
  });
}

function mockSchedules(): { schedules: ScheduleResponse[] } {
  return {
    schedules: [
      createMockScheduleResponse({
        id: "f0000000-0000-4000-a000-000000000001",
        agentId: "c0000000-0000-4000-a000-000000000002",
        name: "daily-run",
        cronExpression: "0 9 * * *",
        prompt: "Run the daily digest",
        description: "Daily digest summary",
        createdAt: "2024-06-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      }),
      createMockScheduleResponse({
        id: "f0000000-0000-4000-a000-000000000002",
        agentId: "c0000000-0000-4000-a000-000000000003",
        name: "other-run",
        cronExpression: "0 12 * * *",
        prompt: "Something else",
        createdAt: "2024-06-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      }),
    ],
  };
}

function registerStandardHandlers() {
  setMockSchedules(mockSchedules().schedules);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, mockAgentResponse());
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, mockInstructions());
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    }),
  );
}

function setupWithAgent() {
  registerStandardHandlers();
  detachedSetupPage({ context, path: "/", withoutRender: true });
  context.store.set(setActiveAgent$, "my-agent");
}

describe("zero-job-detail signals", () => {
  describe("setActiveAgent$ and reactive data loading", () => {
    it("should fetch detail, instructions, and schedules successfully", async () => {
      const agentResponse = mockAgentResponse();
      setMockSchedules(mockSchedules().schedules);
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, agentResponse);
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, mockInstructions());
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");

      const detail = await context.store.get(zeroJobDetail$);
      expect(detail).toStrictEqual(agentResponse);

      const instructions = await context.store.get(zeroJobInstructions$);
      expect(instructions).toStrictEqual(mockInstructions());

      const entries = await context.store.get(zeroJobScheduleEntries$);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("daily-run");
      expect(entries[0]!.time).toBe("Every day at 9:00 AM");
      expect(entries[0]!.description).toBe("Daily digest summary");
    });

    it("should pass agent name directly to API", async () => {
      let capturedUrl = "";
      // mockApi cannot be used here: the agent name "my-org/sub-agent" contains a literal slash,
      // which MSW resolves as a path separator, so a wildcard pattern is the only way to match it.
      server.use(
        http.get("http://localhost:3000/api/zero/agents/*", ({ request }) => {
          const url = request.url;
          if (url.includes("/instructions")) {
            return HttpResponse.json(mockInstructions());
          }
          if (url.includes("/user-connectors")) {
            return HttpResponse.json({ enabledTypes: [] });
          }
          capturedUrl = url;
          return HttpResponse.json(mockAgentResponse());
        }),
      );
      setMockSchedules([]);

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-org/sub-agent");

      const detail = await context.store.get(zeroJobDetail$);
      expect(detail).not.toBeNull();
      // Verify the agent name was included in the URL (percent-encoded)
      expect(capturedUrl).toContain("my-org");
      expect(capturedUrl).toContain("sub-agent");
    });

    it("should derive permission policies from detail", async () => {
      const policies = {
        search: { policies: { read: "allow" as const } },
      };
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, {
            ...mockAgentResponse(),
            permissionPolicies: policies,
          });
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");

      const permissions = await context.store.get(zeroJobPermissionPolicies$);
      expect(permissions).toStrictEqual(policies);
    });

    it("should reset draft states on agent switch", async () => {
      await setupWithAgent();
      await context.store.get(zeroJobDetail$);

      // Make edits
      context.store.set(setZeroJobEditedContent$, "some edit");
      expect(context.store.get(zeroJobEditedContent$)).toBe("some edit");

      // Switch agent
      context.store.set(setActiveAgent$, "my-agent");

      // Edits should be cleared
      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
    });
  });

  describe("saveZeroJobSchedule$", () => {
    it("should save a cron schedule with every_day frequency", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupWithAgent();
      await context.store.get(zeroJobDetail$);

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, mockDeployScheduleResponse());
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
      await context.store.get(zeroJobDetail$);

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, mockDeployScheduleResponse());
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
      await context.store.get(zeroJobDetail$);

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, mockDeployScheduleResponse());
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
      await context.store.get(zeroJobDetail$);

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(201, mockDeployScheduleResponse());
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
  });

  describe("deleteZeroJobSchedule$", () => {
    it("should send DELETE request with correct URL", async () => {
      let capturedUrl = "";

      await setupWithAgent();
      await context.store.get(zeroJobDetail$);

      setMockSchedules([]);
      server.use(
        mockApi(zeroSchedulesByNameContract.delete, ({ request, respond }) => {
          capturedUrl = request.url;
          return respond(204);
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
  });

  describe("toggleZeroJobScheduleEnabled$", () => {
    it("should send enable request with agentId in body", async () => {
      let capturedUrl = "";
      let capturedBody: Record<string, unknown> | null = null;

      await setupWithAgent();
      await context.store.get(zeroJobDetail$);

      setMockSchedules(mockSchedules().schedules);
      server.use(
        mockApi(
          zeroSchedulesEnableContract.enable,
          ({ request, body, respond }) => {
            capturedUrl = request.url;
            capturedBody = body as Record<string, unknown>;
            return respond(200, mockScheduleResponse());
          },
        ),
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

      await setupWithAgent();
      await context.store.get(zeroJobDetail$);

      setMockSchedules(mockSchedules().schedules);
      server.use(
        mockApi(zeroSchedulesEnableContract.disable, ({ request, respond }) => {
          capturedUrl = request.url;
          return respond(200, mockScheduleResponse());
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
  });

  describe("instructions editing", () => {
    async function setupWithInstructions() {
      setMockSchedules([]);
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, mockInstructions());
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");
      // Wait for data to load
      await context.store.get(zeroJobDetail$);
      await context.store.get(zeroJobInstructions$);
    }

    it("should track edited content and dirty state", async () => {
      await setupWithInstructions();

      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      await expect(
        context.store.get(zeroJobInstructionsDirty$),
      ).resolves.toBeFalsy();

      context.store.set(setZeroJobEditedContent$, "New instructions");

      expect(context.store.get(zeroJobEditedContent$)).toBe("New instructions");
      await expect(
        context.store.get(zeroJobInstructionsDirty$),
      ).resolves.toBeTruthy();
    });

    it("should reset edited content on discard", async () => {
      await setupWithInstructions();

      context.store.set(setZeroJobEditedContent$, "New instructions");
      await expect(
        context.store.get(zeroJobInstructionsDirty$),
      ).resolves.toBeTruthy();

      context.store.set(discardZeroJobEdit$);

      expect(context.store.get(zeroJobEditedContent$)).toBeNull();
      await expect(
        context.store.get(zeroJobInstructionsDirty$),
      ).resolves.toBeFalsy();
    });

    it("should build instructions via zero agents api and update state", async () => {
      let capturedBody: { content: string } | null = null;

      await setupWithInstructions();

      server.use(
        mockApi(zeroAgentInstructionsContract.update, ({ body, respond }) => {
          capturedBody = body;
          return respond(200, {
            agentId: "c0000000-0000-4000-a000-000000000002",
            ownerId: "test-owner-id",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: null,
            customSkills: [],
          });
        }),
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, {
            content: "Updated instructions",
            filename: "instructions.md",
          });
        }),
      );

      context.store.set(setZeroJobEditedContent$, "Updated instructions");
      await context.store.set(buildZeroJobInstructions$, context.signal);

      // Should have sent the edited content via zero agents instructions API
      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.content).toBe("Updated instructions");

      // After build, edited content should be cleared
      expect(context.store.get(zeroJobEditedContent$)).toBeNull();

      // Instructions should be updated after reload
      const instructions = await context.store.get(zeroJobInstructions$);
      expect(instructions?.content).toBe("Updated instructions");
    });

    it("should not build when no edited content", async () => {
      let apiCalled = false;

      await setupWithInstructions();

      server.use(
        mockApi(zeroAgentInstructionsContract.update, ({ respond }) => {
          apiCalled = true;
          return respond(200, {
            agentId: "c0000000-0000-4000-a000-000000000002",
            ownerId: "test-owner-id",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            permissionPolicies: null,
            customSkills: [],
          });
        }),
      );

      await context.store.set(buildZeroJobInstructions$, context.signal);
      expect(apiCalled).toBeFalsy();
    });
  });

  describe("zeroJobUpdateSettings$", () => {
    async function setupSettings() {
      setMockSchedules([]);
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, mockInstructions());
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");
      await context.store.get(zeroJobDetail$);
    }

    it("should update settings via PATCH agents API and refetch", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupSettings();

      server.use(
        mockApi(zeroAgentsByIdContract.updateMetadata, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(200, {
            ...mockAgentResponse(),
            displayName: "New Name",
            sound: "friendly",
          });
        }),
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
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
    });

    it("should send empty update via PATCH agents API", async () => {
      let patchCalled = false;

      await setupSettings();

      server.use(
        mockApi(zeroAgentsByIdContract.updateMetadata, ({ respond }) => {
          patchCalled = true;
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
      );

      await context.store.set(zeroJobUpdateSettings$, {}, context.signal);

      // The PATCH is always sent — idempotency is handled server-side
      expect(patchCalled).toBeTruthy();
    });

    it("should not include modelProviderId/selectedModel when the update omits them", async () => {
      let capturedBody: Record<string, unknown> = {};

      await setupSettings();

      server.use(
        mockApi(zeroAgentsByIdContract.updateMetadata, ({ body, respond }) => {
          capturedBody = body as Record<string, unknown>;
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
      );

      await context.store.set(
        zeroJobUpdateSettings$,
        { displayName: "Just a rename" },
        context.signal,
      );

      // Regression: partial updates must not clobber stored model selection
      // with `null`. Callers that don't touch the model picker should send a
      // payload that omits these keys entirely.
      expect(capturedBody).not.toHaveProperty("modelProviderId");
      expect(capturedBody).not.toHaveProperty("selectedModel");
    });
  });

  describe("zeroJobDetail$ model provider fields", () => {
    it("should expose modelProviderId and selectedModel from the agent response", async () => {
      setMockSchedules([]);
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, {
            ...mockAgentResponse(),
            modelProviderId: "a1111111-1111-4111-a111-111111111111",
            selectedModel: "claude-opus-4-7",
          });
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, mockInstructions());
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");
      const detail = await context.store.get(zeroJobDetail$);

      // Regression: the AgentDetail type must preserve these fields so the
      // profile tab can render the saved selection instead of "from org
      // default" after a page refresh.
      expect(detail?.modelProviderId).toBe(
        "a1111111-1111-4111-a111-111111111111",
      );
      expect(detail?.selectedModel).toBe("claude-opus-4-7");
    });
  });

  describe("connectors management", () => {
    async function setupWithConnectors() {
      setMockSchedules([]);
      server.use(
        mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
          return respond(200, mockAgentResponse());
        }),
        mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
          return respond(200, mockInstructions());
        }),
        mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
          return respond(200, { enabledTypes: ["search"] });
        }),
      );

      detachedSetupPage({ context, path: "/", withoutRender: true });
      context.store.set(setActiveAgent$, "my-agent");
      await context.store.get(zeroJobDetail$);
    }

    it("should seed connectors from user-connectors api", async () => {
      await setupWithConnectors();

      const connectors = await context.store.get(zeroJobAddedConnectors$);
      expect(connectors).toStrictEqual(["search"]);
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeFalsy();
    });

    it("should add and remove connectors with dirty tracking", async () => {
      await setupWithConnectors();

      await context.store.set(addZeroJobConnector$, "gmail", context.signal);

      await expect(
        context.store.get(zeroJobAddedConnectors$),
      ).resolves.toStrictEqual(["search", "gmail"]);
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeTruthy();

      await context.store.set(
        removeZeroJobConnector$,
        "search",
        context.signal,
      );

      await expect(
        context.store.get(zeroJobAddedConnectors$),
      ).resolves.toStrictEqual(["gmail"]);
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeTruthy();
    });

    it("should discard connector changes", async () => {
      await setupWithConnectors();

      await context.store.set(addZeroJobConnector$, "gmail", context.signal);
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeTruthy();

      context.store.set(discardZeroJobConnectors$);

      await expect(
        context.store.get(zeroJobAddedConnectors$),
      ).resolves.toStrictEqual(["search"]);
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeFalsy();
    });

    it("should save connectors via user-connectors api", async () => {
      let capturedBody: { enabledTypes: string[] } | null = null;

      await setupWithConnectors();

      // Add "gmail" before registering the PUT handler to avoid the GET
      // override affecting the seed data used by addZeroJobConnector$
      await context.store.set(addZeroJobConnector$, "gmail", context.signal);

      server.use(
        mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
          capturedBody = body;
          return respond(200, { enabledTypes: body.enabledTypes });
        }),
        mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
          return respond(200, { enabledTypes: ["search", "gmail"] });
        }),
      );

      await context.store.set(saveZeroJobConnectors$, context.signal);

      // Verify connectors were sent as enabledTypes
      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.enabledTypes).toStrictEqual(["search", "gmail"]);

      // After save, dirty state should be reset
      await expect(
        context.store.get(zeroJobConnectorsDirty$),
      ).resolves.toBeFalsy();
    });
  });
});
