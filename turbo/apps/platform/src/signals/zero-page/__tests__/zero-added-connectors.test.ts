import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { zeroAddedConnectors$, addZeroConnector$ } from "../zero-connectors.ts";
const context = testContext();

function mockAgentApi(connectors: string[]) {
  server.use(
    http.get("*/api/zero/agents/:name", ({ params }) => {
      if (
        params.name === "instructions" ||
        (typeof params.name === "string" && params.name.includes("/"))
      ) {
        return;
      }
      return HttpResponse.json({
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
      });
    }),
    http.get(
      "*/api/zero/agents/c0000000-0000-4000-a000-000000000001/user-connectors",
      () => {
        return HttpResponse.json({ enabledTypes: connectors });
      },
    ),
  );
}

describe("zeroAddedConnectors$", () => {
  it("should seed connectors from user-connectors api", async () => {
    mockAgentApi(["slack", "github"]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Server filters out seed skills, only user connectors remain
    expect(connectors).toStrictEqual(["slack", "github"]);
  });

  it("should return empty connectors when agent has none", async () => {
    mockAgentApi([]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toStrictEqual([]);
  });

  it("should seed connectors from sub-agent when chat agent is set", async () => {
    // Default agent has slack
    mockAgentApi(["slack"]);

    // Sub-agent has github only
    server.use(
      http.get("*/api/zero/agents/sub-agent-compose-id", () => {
        return HttpResponse.json({
          agentId: "sub-agent-compose-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
        });
      }),
      http.get("*/api/zero/agents/sub-agent-compose-id/user-connectors", () => {
        return HttpResponse.json({ enabledTypes: ["github"] });
      }),
      // Include cycling-coach in the team list so route setup resolves it
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
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
      }),
    );

    await setupPage({
      context,
      path: "/agents/sub-agent-compose-id/chat",
      withoutRender: true,
    });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Only sub-agent connectors (server already filters seed skills)
    expect(connectors).toStrictEqual(["github"]);
  });
});

describe("addZeroConnector$", () => {
  it("should add a connector via user-connectors api", async () => {
    let capturedBody: { enabledTypes: string[] } | null = null;

    mockAgentApi(["slack"]);

    server.use(
      http.put(
        "*/api/zero/agents/c0000000-0000-4000-a000-000000000001/user-connectors",
        async ({ request }) => {
          capturedBody = (await request.json()) as { enabledTypes: string[] };
          return HttpResponse.json({ enabledTypes: capturedBody.enabledTypes });
        },
      ),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    // Add connector — saves immediately via user-connectors API
    await context.store.set(addZeroConnector$, "github", context.signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.enabledTypes).toContain("slack");
    expect(capturedBody!.enabledTypes).toContain("github");
  });
});
