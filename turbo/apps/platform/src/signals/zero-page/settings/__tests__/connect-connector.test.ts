import { describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import {
  connectConnector$,
  permissionDialogType$,
  pollingConnectorType$,
  submitApiToken$,
} from "../connectors.ts";
import { triggerAblyEvent, hasSubscription } from "../../../../mocks/ably.ts";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { createMockApi } from "../../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeEmptyConnectorResponse(): ConnectorListResponse {
  return {
    connectors: [],
    configuredTypes: [],
    connectorProvidedSecretNames: [],
  };
}

function makeGithubConnectorResponse(): ConnectorListResponse {
  return {
    connectors: [
      {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        type: "github",
        authMethod: "oauth",
        externalId: "12345",
        externalUsername: "testuser",
        externalEmail: "test@example.com",
        oauthScopes: ["repo", "read:user"],
        needsReconnect: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    configuredTypes: ["github"],
    connectorProvidedSecretNames: [],
  };
}

function mockMatchMedia(standalone: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: standalone,
    media: "(display-mode: standalone)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList);
}

describe("connectConnector$", () => {
  it("detects connector via connector:changed Ably event", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        pollCount++;
        if (pollCount <= 1) {
          return respond(200, makeEmptyConnectorResponse());
        }
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      {},
      context.signal,
    );

    // Wait for initial fetch + subscribe.
    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(1);
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });

    // Simulate the OAuth callback publishing the signal.
    triggerAblyEvent("connector:changed");

    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(context.store.get(pollingConnectorType$)).toBeNull();
  });

  it("keeps subscribing on reconnect until updatedAt changes", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    // Existing connector with a stable updatedAt simulates the pre-reconnect
    // state; the loop should not exit until the updatedAt changes.
    const initialUpdatedAt = "2026-01-01T00:00:00.000Z";
    const initialResponse: ConnectorListResponse = {
      ...makeGithubConnectorResponse(),
      connectors: [
        {
          ...makeGithubConnectorResponse().connectors[0],
          oauthScopes: ["repo"],
          createdAt: initialUpdatedAt,
          updatedAt: initialUpdatedAt,
        },
      ],
    };

    let pollCount = 0;
    const reconnectedUpdatedAt = "2026-02-01T00:00:00.000Z";
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        pollCount++;
        // First fetch captures initialUpdatedAt; second fetch still shows
        // the stale value (OAuth callback not yet complete); third fetch
        // reflects the completed reconnect with a new updatedAt.
        if (pollCount <= 2) {
          return respond(200, initialResponse);
        }
        return respond(200, {
          ...initialResponse,
          connectors: [
            {
              ...initialResponse.connectors[0],
              oauthScopes: ["repo", "project"],
              updatedAt: reconnectedUpdatedAt,
            },
          ],
        });
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(1);
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });

    // First event: still stale.
    triggerAblyEvent("connector:changed");
    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });

    // Second event: reconnect completed — updatedAt changed.
    triggerAblyEvent("connector:changed");

    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBeNull();
  });

  it("sets permissionDialogType$ after connector appears when requested", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      { showPermissionDialog: true },
      context.signal,
    );

    // Initial fetch snapshots the existing updatedAt. The appearance happens
    // via a second fetch triggered by the Ably event.
    await vi.waitFor(() => {
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    triggerAblyEvent("connector:changed");

    await connectPromise;

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("completes oauth flow in standalone mode without popup dimensions", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    triggerAblyEvent("connector:changed");

    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBeNull();
  });

  it("handles multiple fetch cycles in standalone mode", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    let pollCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        pollCount++;
        if (pollCount < 3) {
          return respond(200, makeEmptyConnectorResponse());
        }
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    // First Ably event: still empty.
    triggerAblyEvent("connector:changed");
    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });
    // Second Ably event: connector appears.
    triggerAblyEvent("connector:changed");

    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBeNull();
  });
});

describe("submitApiToken$", () => {
  it("sets permissionDialogType$ after successful API token submission", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      submitApiToken$,
      "github",
      { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test123" },
      { showPermissionDialog: true },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });
});
