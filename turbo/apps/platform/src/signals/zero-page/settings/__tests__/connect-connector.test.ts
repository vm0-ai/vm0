import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import {
  connectConnector$,
  permissionDialogType$,
  pollingConnectorType$,
  submitApiToken$,
  STANDALONE_POLLING_TIMEOUT_MS,
} from "../connectors.ts";
import { createDeferredPromise } from "../../../utils.ts";
import type { ConnectorListResponse } from "@vm0/core";

vi.mock("signal-timers", async (importOriginal) => {
  const mod = await importOriginal<typeof import("signal-timers")>();
  return {
    ...mod,
    delay: () => {
      return Promise.resolve();
    },
  };
});

const context = testContext();

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
  it("detects connector via API polling while popup is open", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    const secondPollDeferred = createDeferredPromise<void>(context.signal);
    let deferredResolved = false;
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        if (pollCount <= 1) {
          return HttpResponse.json(makeEmptyConnectorResponse());
        }
        if (!deferredResolved) {
          deferredResolved = true;
          secondPollDeferred.resolve();
        }
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    await secondPollDeferred.promise;
    const result = await connectPromise;

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(2);

    const polling = context.store.get(pollingConnectorType$);
    expect(polling).toBeNull();
  });

  it("keeps polling on reconnect until updatedAt changes", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    // Existing connector with a stable updatedAt simulates the pre-reconnect
    // state; the poll loop should not exit until the updatedAt changes.
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
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        // First poll captures initialUpdatedAt; second poll still shows the
        // stale value (OAuth callback not yet complete); third poll reflects
        // the completed reconnect with a new updatedAt.
        if (pollCount <= 2) {
          return HttpResponse.json(initialResponse);
        }
        return HttpResponse.json({
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

    const result = await context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    expect(result).toBeTruthy();
    // One capture poll + one stale poll + one fresh poll.
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("exits when popup is closed even if connector not found", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        if (pollCount >= 2) {
          mockWindow.closed = true;
        }
        return HttpResponse.json(makeEmptyConnectorResponse());
      }),
    );

    const result = await context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    expect(result).toBeFalsy();

    const polling = context.store.get(pollingConnectorType$);
    expect(polling).toBeNull();
  });

  it("sets permissionDialogType$ after successful OAuth connection", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    await context.store.set(connectConnector$, "github", context.signal);

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("does not set permissionDialogType$ when popup closed without connecting", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        if (pollCount >= 1) {
          mockWindow.closed = true;
        }
        return HttpResponse.json(makeEmptyConnectorResponse());
      }),
    );

    await context.store.set(connectConnector$, "github", context.signal);

    expect(context.store.get(permissionDialogType$)).toBeNull();
  });

  it("completes oauth flow in standalone mode without popup dimensions", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    const result = await context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    // Connector was found via polling — flow completed successfully
    expect(result).toBeTruthy();
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("polls after connector appears following multiple poll cycles in standalone mode", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    // First two polls return empty; third returns the connector,
    // simulating the user completing OAuth in external Safari then returning.
    let pollCount = 0;
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        if (pollCount < 3) {
          return HttpResponse.json(makeEmptyConnectorResponse());
        }
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    const result = await context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    expect(result).toBeTruthy();
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(context.store.get(pollingConnectorType$)).toBeNull();
    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("exits polling after timeout in standalone mode", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    // First Date.now() call sets startTime inside connectConnector$; all
    // subsequent calls return a value past the timeout threshold so the
    // very first polling iteration exits immediately.
    const realNow = Date.now();
    let firstCall = true;
    vi.spyOn(Date, "now").mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return realNow;
      }
      return realNow + STANDALONE_POLLING_TIMEOUT_MS + 1;
    });

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeEmptyConnectorResponse());
      }),
    );

    const result = await context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    expect(result).toBeFalsy();
    expect(context.store.get(pollingConnectorType$)).toBeNull();
  });
});

describe("submitApiToken$", () => {
  it("sets permissionDialogType$ after successful API token submission", async () => {
    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      submitApiToken$,
      "github",
      { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test123" },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });
});
