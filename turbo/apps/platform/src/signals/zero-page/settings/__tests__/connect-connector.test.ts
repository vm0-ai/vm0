import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import {
  connectConnector$,
  permissionDialogType$,
  pollingConnectorType$,
  submitApiToken$,
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
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    const secondPollDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        if (pollCount <= 1) {
          return HttpResponse.json(makeEmptyConnectorResponse());
        }
        secondPollDeferred.resolve();
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

  it("exits when popup is closed even if connector not found", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

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
    await setupPage({ context, path: "/", withoutRender: true });

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
    await setupPage({ context, path: "/", withoutRender: true });

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

  it("opens without popup features in standalone mode", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    openSpy.mockClear();

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    await context.store.set(connectConnector$, "github", context.signal);

    expect(openSpy).toHaveBeenCalledWith(expect.any(String), "_blank");
    expect(openSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      "_blank",
      expect.stringContaining("width"),
    );
  });

  it("does not throw when window.open returns null in standalone mode", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

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

    expect(result).toBeTruthy();
    expect(context.store.get(pollingConnectorType$)).toBeNull();
  });

  it("exits polling after timeout in standalone mode", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    mockMatchMedia(true);
    vi.spyOn(window, "open").mockReturnValue(null);

    // Mock Date.now to simulate timeout elapsed
    const startTime = Date.now();
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      callCount++;
      // After 3 calls, simulate timeout exceeded (> 10 minutes)
      if (callCount > 3) {
        return startTime + 11 * 60 * 1000;
      }
      return startTime;
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

    vi.spyOn(Date, "now").mockRestore();
  });
});

describe("submitApiToken$", () => {
  it("sets permissionDialogType$ after successful API token submission", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(
      submitApiToken$,
      "github",
      { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test123" },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });
});
