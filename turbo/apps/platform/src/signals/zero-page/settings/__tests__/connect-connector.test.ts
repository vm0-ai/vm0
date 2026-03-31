import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { connectConnector$, pollingConnectorType$ } from "../connectors.ts";
import type { ConnectorListResponse } from "@vm0/core";

const context = testContext();

const GITHUB_CONNECTOR_RESPONSE: ConnectorListResponse = {
  connectors: [
    {
      type: "github",
      authMethod: "oauth",
      externalId: "12345",
      externalUsername: "testuser",
      externalEmail: "test@example.com",
      oauthScopes: ["repo", "read:user"],
      tokenExpiresAt: null,
      needsReconnect: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  configuredTypes: ["github"],
  connectorProvidedSecretNames: [],
};

describe("connectConnector$", () => {
  it("exits polling when BroadcastChannel message arrives", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    // After BroadcastChannel notification, API returns the connected connector
    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(GITHUB_CONNECTOR_RESPONSE);
      }),
    );

    const connectPromise = context.store.set(
      connectConnector$,
      "github",
      context.signal,
    );

    // Simulate OAuth success via BroadcastChannel
    const channel = new BroadcastChannel("vm0:connector-oauth");
    channel.postMessage({ connectorType: "github", status: "success" });
    channel.close();

    const result = await connectPromise;

    expect(result).toBe(true);
    expect(mockWindow.close).toHaveBeenCalled();

    // Polling state should be cleared
    const polling = context.store.get(pollingConnectorType$);
    expect(polling).toBeNull();
  });

  it("falls back to authWindow.closed when BroadcastChannel is unavailable", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(GITHUB_CONNECTOR_RESPONSE);
      }),
    );

    // Hide BroadcastChannel to test fallback
    const OriginalBC = globalThis.BroadcastChannel;
    // @ts-expect-error -- intentionally removing for test
    delete globalThis.BroadcastChannel;

    try {
      const connectPromise = context.store.set(
        connectConnector$,
        "github",
        context.signal,
      );

      // Simulate popup closing after a tick
      setTimeout(() => {
        mockWindow.closed = true;
      }, 100);

      const result = await connectPromise;
      expect(result).toBe(true);
    } finally {
      globalThis.BroadcastChannel = OriginalBC;
    }
  });
});
