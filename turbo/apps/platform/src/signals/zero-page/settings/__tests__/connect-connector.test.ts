import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { connectConnector$, pollingConnectorType$ } from "../connectors.ts";
import type { ConnectorListResponse } from "@vm0/core";

const context = testContext();

function makeGithubConnectorResponse(): ConnectorListResponse {
  return {
    connectors: [
      {
        id: "conn-12345",
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

  it("exits polling when BroadcastChannel message arrives", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const mockWindow = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(mockWindow as unknown as Window);

    // After BroadcastChannel notification, API returns the connected connector
    server.use(
      http.get("*/api/zero/connectors", () => {
        return HttpResponse.json(makeGithubConnectorResponse());
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

    expect(result).toBeTruthy();
    expect(mockWindow.close).toHaveBeenCalledWith();

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
        return HttpResponse.json(makeGithubConnectorResponse());
      }),
    );

    // Hide BroadcastChannel to test fallback
    const OriginalBC = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, "BroadcastChannel", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    try {
      vi.useFakeTimers();

      const connectPromise = context.store.set(
        connectConnector$,
        "github",
        context.signal,
      );

      // Advance past the first polling interval, then simulate popup closing
      await vi.advanceTimersByTimeAsync(500);
      mockWindow.closed = true;
      await vi.advanceTimersByTimeAsync(500);

      const result = await connectPromise;
      expect(result).toBeTruthy();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(globalThis, "BroadcastChannel", {
        value: OriginalBC,
        writable: true,
        configurable: true,
      });
    }
  });
});
