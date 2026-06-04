import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  zeroAuthorizedConnectors$,
  authorizeConnector$,
} from "../zero-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAgentApi(connectors: string[]) {
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        customSkills: [],
      });
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: connectors });
    }),
  );
}

describe("zeroAuthorizedConnectors$", () => {
  it("should return authorized connectors from user-connectors api", async () => {
    mockAgentApi(["slack", "github"]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAuthorizedConnectors$);
    expect(connectors).toStrictEqual(["slack", "github"]);
  });

  it("should return empty connectors when agent has none", async () => {
    mockAgentApi([]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAuthorizedConnectors$);
    expect(connectors).toStrictEqual([]);
  });

  it("should return authorized connectors from sub-agent when chat agent is set", async () => {
    // Default agent has slack
    mockAgentApi(["slack"]);

    // Sub-agent has github only
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "sub-agent-compose-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          customSkills: [],
        });
      }),
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
    );
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "sub-agent-compose-id",
        displayName: "Cycling Coach",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_2",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    await setupPage({
      context,
      path: "/agents/sub-agent-compose-id/chat",
      withoutRender: true,
    });

    const connectors = await context.store.get(zeroAuthorizedConnectors$);
    expect(connectors).toStrictEqual(["github"]);
  });
});

describe("authorizeConnector$", () => {
  it("should authorize a connector via user-connectors api", async () => {
    let capturedBody: { enabledTypes: string[] } | null = null;

    mockAgentApi(["slack"]);

    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(authorizeConnector$, "github", context.signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.enabledTypes).toContain("slack");
    expect(capturedBody!.enabledTypes).toContain("github");
  });

  it("should not fire a PUT when the connector is already authorized", async () => {
    let putCalls = 0;

    mockAgentApi(["slack"]);

    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        putCalls += 1;
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(authorizeConnector$, "slack", context.signal);

    expect(putCalls).toBe(0);
  });
});
