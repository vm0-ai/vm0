import { describe, expect, it } from "vitest";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setMockLocalAgentHosts } from "../../../../mocks/handlers/api-local-agent.ts";
import {
  allConnectorTypes$,
  connectLocalAgentConnector$,
  permissionDialogType$,
} from "../connectors.ts";

const context = testContext();

describe("local-agent connector", () => {
  it("shows online local-agent hosts without treating them as connected", async () => {
    setMockLocalAgentHosts([
      {
        id: "host-online",
        displayName: "Work laptop",
        supportedBackends: ["codex"],
        status: "online",
        lastSeenAt: "2026-05-12T00:00:00.000Z",
        createdAt: "2026-05-12T00:00:00.000Z",
      },
      {
        id: "host-closed",
        displayName: "Old desktop",
        supportedBackends: ["claude-code"],
        status: "closed",
        lastSeenAt: "2026-05-11T00:00:00.000Z",
        createdAt: "2026-05-11T00:00:00.000Z",
      },
    ]);
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const localAgent = connectors.find((connector) => {
      return connector.type === "local-agent";
    });

    expect(localAgent?.availableAuthMethods).toStrictEqual(["api"]);
    expect(localAgent?.connected).toBeFalsy();
    expect(localAgent?.localAgentHosts).toStrictEqual([
      expect.objectContaining({
        id: "host-online",
        displayName: "Work laptop",
      }),
    ]);
  });

  it("opens the agent auth dialog after connecting from settings", async () => {
    setMockLocalAgentHosts([
      {
        id: "host-online",
        displayName: "Work laptop",
        supportedBackends: ["codex"],
        status: "online",
        lastSeenAt: "2026-05-12T00:00:00.000Z",
        createdAt: "2026-05-12T00:00:00.000Z",
      },
    ]);
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    await context.store.set(
      connectLocalAgentConnector$,
      { showPermissionDialog: true },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("local-agent");
  });
});
