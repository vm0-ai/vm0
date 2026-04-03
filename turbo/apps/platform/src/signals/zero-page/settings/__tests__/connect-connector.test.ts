import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { ConnectorListResponse } from "@vm0/core";

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

describe("connectConnector$", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects connector via API polling while popup is open", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    let pollCount = 0;
    server.use(
      http.get("*/api/zero/connectors", () => {
        pollCount++;
        // First poll returns empty, second returns connected
        if (pollCount <= 1) {
          return HttpResponse.json(makeEmptyConnectorResponse());
        }
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    vi.useFakeTimers();

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    // Advance past first polling interval (2s) — connector not yet connected
    await vi.advanceTimersByTimeAsync(2000);
    // Advance past second polling interval — connector now connected
    await vi.advanceTimersByTimeAsync(2000);

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

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeEmptyConnectorResponse());
      }),
    );

    vi.useFakeTimers();

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    // Advance one poll interval, then close popup
    await vi.advanceTimersByTimeAsync(2000);
    mockWindow.closed = true;
    await vi.advanceTimersByTimeAsync(2000);

    const result = await connectPromise;
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

    vi.useFakeTimers();

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    await vi.advanceTimersByTimeAsync(2000);

    await connectPromise;

    expect(context.store.get(permissionDialogType$)).toBe("github");
  });

  it("does not set permissionDialogType$ when popup closed without connecting", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeEmptyConnectorResponse());
      }),
    );

    vi.useFakeTimers();

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    await vi.advanceTimersByTimeAsync(2000);
    mockWindow.closed = true;
    await vi.advanceTimersByTimeAsync(2000);

    await connectPromise;

    expect(context.store.get(permissionDialogType$)).toBeNull();
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
