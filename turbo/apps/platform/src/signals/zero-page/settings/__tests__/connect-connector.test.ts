import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import {
  clearConnectorOAuthDeviceAuth$,
  connectConnectorOAuthAuthCode$,
  connectConnectorOAuthDeviceAuth$,
  connectorOAuthDeviceAuthState$,
  openConnectorOAuthDeviceAuthVerificationPage$,
  permissionDialogType$,
  pollingOAuthAuthCodeConnectorType$,
  pollingOAuthDeviceAuthConnectorType$,
  submitManualGrant$,
} from "../connectors.ts";
import { triggerAblyEvent, hasSubscription } from "../../../../mocks/ably.ts";
import type {
  ConnectorListResponse,
  ConnectorResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOauthStartContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createMockApi } from "../../../../mocks/msw-contract.ts";
import { resetSignal } from "../../../utils.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeEmptyConnectorResponse(): ConnectorListResponse {
  return {
    connectors: [],
    configuredTypes: [],
    connectorProvidedEnvNames: [],
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
    connectorProvidedEnvNames: [],
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

function mockConnectorOauthStart() {
  server.use(
    mockApi(zeroConnectorOauthStartContract.start, ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    }),
  );
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

function returnFalseForAbortError(error: unknown): false {
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  ) {
    return false;
  }
  throw error;
}

function makeTestOauthDeviceConnectorResponse(): ConnectorResponse {
  return {
    id: "00000000-0000-4000-8000-000000000124",
    type: "test-oauth-device",
    authMethod: "oauth",
    externalId: "test-oauth-device-user",
    externalUsername: "device-user",
    externalEmail: null,
    oauthScopes: ["read"],
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("connectConnectorOAuthAuthCode$", () => {
  beforeEach(() => {
    mockConnectorOauthStart();
  });

  it("detects connector via connector:changed Ably event", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = createMockAuthWindow();
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
      connectConnectorOAuthAuthCode$,
      "github",
      {},
      context.signal,
    );

    // Wait for initial fetch + subscribe.
    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(1);
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });

    // Simulate the auth-code OAuth callback publishing the signal.
    triggerAblyEvent("connector:changed");

    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
  });

  it("clears polling when the auth-code OAuth popup closes before connector appears", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = createMockAuthWindow();
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        pollCount++;
        return respond(200, makeEmptyConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnectorOAuthAuthCode$,
      "github",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(1);
      expect(hasSubscription("connector:changed")).toBeTruthy();
      expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBe(
        "github",
      );
    });

    mockWindow.closed = true;

    await expect(connectPromise).resolves.toBeFalsy();
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
    expect(hasSubscription("connector:changed")).toBeFalsy();
  });

  it("clears polling when the authorization popup fails to open", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    vi.spyOn(window, "open").mockReturnValue(null);

    await expect(
      context.store.set(
        connectConnectorOAuthAuthCode$,
        "github",
        {},
        context.signal,
      ),
    ).rejects.toThrow("Failed to open authorization window");
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
  });

  it("opens connector OAuth on the web host when apiBackend is enabled", async () => {
    vi.stubGlobal("location", new URL("https://app.vm0.ai/connectors"));
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { apiBackend: true },
    });

    const mockWindow = createMockAuthWindow();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    let startRequestUrl: string | null = null;
    server.use(
      mockApi(
        zeroConnectorOauthStartContract.start,
        ({ request, params, respond }) => {
          startRequestUrl = request.url;
          return respond(200, {
            authorizationUrl: `https://oauth.test/${params.type}/authorize`,
          });
        },
      ),
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        pollCount++;
        if (pollCount <= 1) {
          return respond(200, makeEmptyConnectorResponse());
        }
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnectorOAuthAuthCode$,
      "github",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "about:blank",
        "_blank",
        "width=600,height=700",
      );
      expect(startRequestUrl).toBe(
        "https://www.vm0.ai/api/zero/connectors/github/oauth/start",
      );
      expect(mockWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });
    triggerAblyEvent("connector:changed");

    await expect(connectPromise).resolves.toBeTruthy();
  });

  it("keeps subscribing on reconnect until updatedAt changes", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = createMockAuthWindow();
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
      connectConnectorOAuthAuthCode$,
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
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBeNull();
  });

  it("sets permissionDialogType$ after connector appears when requested", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = createMockAuthWindow();
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnectorOAuthAuthCode$,
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

  it("completes auth-code OAuth flow in standalone mode without popup dimensions", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ respond }) => {
        return respond(200, makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnectorOAuthAuthCode$,
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
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
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
      connectConnectorOAuthAuthCode$,
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
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBeNull();
  });

  it("rejects device-auth connectors before opening popup or starting auth-code flow", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    const open = vi.spyOn(window, "open");
    let startCalled = false;
    server.use(
      mockApi(zeroConnectorOauthStartContract.start, ({ respond }) => {
        startCalled = true;
        return respond(200, {
          authorizationUrl: "https://oauth.test/test-oauth-device/authorize",
        });
      }),
    );

    await expect(
      context.store.set(
        connectConnectorOAuthAuthCode$,
        "test-oauth-device",
        {},
        context.signal,
      ),
    ).rejects.toThrow("test-oauth-device does not use an auth-code grant");

    expect(open).not.toHaveBeenCalled();
    expect(startCalled).toBeFalsy();
    expect(context.store.get(pollingOAuthAuthCodeConnectorType$)).toBeNull();
  });
});

describe("connectConnectorOAuthDeviceAuth$", () => {
  it("shows a code before opening the verification page and polling completion", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    let authCodeStartCalled = false;
    server.use(
      mockApi(zeroConnectorOauthStartContract.start, ({ respond }) => {
        authCodeStartCalled = true;
        return respond(200, {
          authorizationUrl: "https://oauth.test/test-oauth-device/authorize",
        });
      }),
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.create,
        ({ params, respond }) => {
          return respond(200, {
            sessionId: "00000000-0000-4000-8000-000000000123",
            sessionToken: "device-session-token",
            type: params.type,
            status: "pending",
            userCode: "VM0-DEVICE",
            verificationUri: "https://oauth.test/device",
            verificationUriComplete:
              "https://oauth.test/device?user_code=VM0-DEVICE",
            expiresIn: 300,
            interval: 0,
          });
        },
      ),
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.poll,
        ({ respond }) => {
          return respond(200, {
            status: "complete",
            connector: makeTestOauthDeviceConnectorResponse(),
          });
        },
      ),
    );

    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(createMockAuthWindow() as unknown as Window);

    const connectPromise = context.store.set(
      connectConnectorOAuthDeviceAuth$,
      "test-oauth-device",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      const state = context.store.get(connectorOAuthDeviceAuthState$);
      expect(state.status).toBe("pending");
      if (state.status === "pending") {
        expect(state.userCode).toBe("VM0-DEVICE");
      }
    });

    expect(authCodeStartCalled).toBeFalsy();
    expect(open).not.toHaveBeenCalled();

    context.store.set(
      openConnectorOAuthDeviceAuthVerificationPage$,
      "test-oauth-device",
    );

    await expect(connectPromise).resolves.toBeTruthy();
    expect(open).toHaveBeenCalledWith(
      "https://oauth.test/device?user_code=VM0-DEVICE",
      "_blank",
    );
    expect(context.store.get(pollingOAuthDeviceAuthConnectorType$)).toBeNull();
  });

  it("opens the verification URI when complete verification URI is absent", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    server.use(
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.create,
        ({ params, respond }) => {
          return respond(200, {
            sessionId: "00000000-0000-4000-8000-000000000125",
            sessionToken: "device-session-token",
            type: params.type,
            status: "pending",
            userCode: "VM0-DEVICE",
            verificationUri: "https://oauth.test/device/manual",
            expiresIn: 300,
            interval: 0,
          });
        },
      ),
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.poll,
        ({ respond }) => {
          return respond(200, {
            status: "complete",
            connector: makeTestOauthDeviceConnectorResponse(),
          });
        },
      ),
    );

    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(createMockAuthWindow() as unknown as Window);

    const connectPromise = context.store.set(
      connectConnectorOAuthDeviceAuth$,
      "test-oauth-device",
      {},
      context.signal,
    );

    await vi.waitFor(() => {
      expect(context.store.get(connectorOAuthDeviceAuthState$).status).toBe(
        "pending",
      );
    });

    context.store.set(
      openConnectorOAuthDeviceAuthVerificationPage$,
      "test-oauth-device",
    );

    await expect(connectPromise).resolves.toBeTruthy();
    expect(open).toHaveBeenCalledWith(
      "https://oauth.test/device/manual",
      "_blank",
    );
  });

  it("keeps pending state active and updates the poll interval", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    server.use(
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.create,
        ({ params, respond }) => {
          return respond(200, {
            sessionId: "00000000-0000-4000-8000-000000000126",
            sessionToken: "device-session-token",
            type: params.type,
            status: "pending",
            userCode: "VM0-DEVICE",
            verificationUri: "https://oauth.test/device",
            verificationUriComplete:
              "https://oauth.test/device?user_code=VM0-DEVICE",
            expiresIn: 300,
            interval: 0,
          });
        },
      ),
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.poll,
        ({ respond }) => {
          return respond(200, {
            status: "pending",
            interval: 2,
          });
        },
      ),
    );

    const connectPromise = (async () => {
      try {
        return await context.store.set(
          connectConnectorOAuthDeviceAuth$,
          "test-oauth-device",
          {},
          context.signal,
        );
      } catch (error) {
        return returnFalseForAbortError(error);
      }
    })();

    await vi.waitFor(() => {
      expect(context.store.get(connectorOAuthDeviceAuthState$).status).toBe(
        "pending",
      );
    });

    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow() as unknown as Window,
    );
    context.store.set(
      openConnectorOAuthDeviceAuthVerificationPage$,
      "test-oauth-device",
    );

    await vi.waitFor(() => {
      const state = context.store.get(connectorOAuthDeviceAuthState$);
      expect(state.status).toBe("pending");
      if (state.status === "pending") {
        expect(state.approvalOpened).toBeTruthy();
        expect(state.pollIntervalMs).toBe(2000);
      }
    });

    context.store.set(clearConnectorOAuthDeviceAuth$);
    await expect(connectPromise).resolves.toBeFalsy();
    expect(context.store.get(pollingOAuthDeviceAuthConnectorType$)).toBeNull();
  });

  it("clears active device auth state when the owning signal aborts", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    server.use(
      mockApi(
        zeroConnectorOauthDeviceAuthSessionContract.create,
        ({ params, respond }) => {
          return respond(200, {
            sessionId: "00000000-0000-4000-8000-000000000127",
            sessionToken: "device-session-token",
            type: params.type,
            status: "pending",
            userCode: "VM0-DEVICE",
            verificationUri: "https://oauth.test/device",
            verificationUriComplete:
              "https://oauth.test/device?user_code=VM0-DEVICE",
            expiresIn: 300,
            interval: 1,
          });
        },
      ),
      mockApi(zeroConnectorOauthDeviceAuthSessionContract.poll, ({ never }) => {
        return never();
      }),
    );

    const flowReset$ = resetSignal();
    const flowSignal = context.store.set(flowReset$, context.signal);
    const connectPromise = (async () => {
      try {
        return await context.store.set(
          connectConnectorOAuthDeviceAuth$,
          "test-oauth-device",
          {},
          flowSignal,
        );
      } catch (error) {
        return returnFalseForAbortError(error);
      }
    })();

    await vi.waitFor(() => {
      expect(context.store.get(connectorOAuthDeviceAuthState$).status).toBe(
        "pending",
      );
    });

    context.store.set(flowReset$, context.signal);

    await expect(connectPromise).resolves.toBeFalsy();
    await vi.waitFor(() => {
      expect(context.store.get(connectorOAuthDeviceAuthState$)).toStrictEqual({
        status: "idle",
        connectorType: "test-oauth-device",
      });
    });
  });
});

describe("submitManualGrant$", () => {
  it("strips whitespace from connector manual grant values before upload", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    let submittedAuthMethod: string | undefined;
    let submitted: Record<string, string> | undefined;

    server.use(
      mockApi(zeroConnectorManualGrantContract.connect, ({ body, respond }) => {
        submittedAuthMethod = body.authMethod;
        submitted = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          type: "strapi",
          authMethod: "api-token",
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          needsReconnect: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }),
    );

    await context.store.set(
      submitManualGrant$,
      {
        type: "strapi",
        authMethod: "api-token",
        inputValues: {
          STRAPI_TOKEN: " strapi\n token ",
          STRAPI_BASE_URL: " https://strapi.example.com\n",
        },
        options: {},
      },
      context.signal,
    );

    expect(submittedAuthMethod).toBe("api-token");
    expect(submitted).toMatchObject({
      STRAPI_TOKEN: "strapitoken",
      STRAPI_BASE_URL: "https://strapi.example.com",
    });
  });

  it("sets permissionDialogType$ after successful manual grant submission", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      submitManualGrant$,
      {
        type: "axiom",
        authMethod: "api-token",
        inputValues: { AXIOM_TOKEN: "xaat_test123" },
        options: { showPermissionDialog: true },
      },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("axiom");
  });
});
