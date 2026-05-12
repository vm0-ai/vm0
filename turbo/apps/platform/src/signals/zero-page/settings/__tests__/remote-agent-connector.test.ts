import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setMockRemoteAgentHosts } from "../../../../mocks/handlers/api-remote-agent.ts";
import {
  allConnectorTypes$,
  connectRemoteAgentConnector$,
  permissionDialogType$,
} from "../connectors.ts";

const context = testContext();

describe("remote-agent connector", () => {
  it("is hidden when the remote-agent feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.RemoteAgent]: false },
    });

    const connectors = await context.store.get(allConnectorTypes$);

    expect(
      connectors.some((connector) => {
        return connector.type === "remote-agent";
      }),
    ).toBeFalsy();
  });

  it("shows online remote-agent hosts without treating them as connected", async () => {
    setMockRemoteAgentHosts([
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
      featureSwitches: { [FeatureSwitchKey.RemoteAgent]: true },
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const remoteAgent = connectors.find((connector) => {
      return connector.type === "remote-agent";
    });

    expect(remoteAgent?.availableAuthMethods).toStrictEqual(["api"]);
    expect(remoteAgent?.connected).toBeFalsy();
    expect(remoteAgent?.remoteAgentHosts).toStrictEqual([
      expect.objectContaining({
        id: "host-online",
        displayName: "Work laptop",
      }),
    ]);
  });

  it("opens the agent auth dialog after connecting from settings", async () => {
    setMockRemoteAgentHosts([
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
      featureSwitches: { [FeatureSwitchKey.RemoteAgent]: true },
    });

    await context.store.set(
      connectRemoteAgentConnector$,
      { showPermissionDialog: true },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("remote-agent");
  });
});
