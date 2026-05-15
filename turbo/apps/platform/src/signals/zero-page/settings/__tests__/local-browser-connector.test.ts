import { describe, expect, it, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import {
  getMockClaimedLocalBrowserDeviceCodes,
  setMockLocalBrowserHosts,
} from "../../../../mocks/handlers/api-local-browser.ts";
import {
  allConnectorTypes$,
  connectLocalBrowserConnector$,
  localBrowserExtensionStatus$,
  pairLocalBrowserExtension$,
  permissionDialogType$,
} from "../connectors.ts";

const context = testContext();

function installLocalBrowserExtensionResponder(signal: AbortSignal) {
  const postMessageSpy = vi.spyOn(window, "postMessage");
  postMessageSpy.mockImplementation((message: unknown) => {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const request = message as Record<string, unknown>;
    if (request.source !== "vm0-local-browser-web") {
      return;
    }
    const requestId = request.requestId;
    if (typeof requestId !== "string") {
      return;
    }

    const response =
      request.type === "vm0.localBrowser.detect"
        ? {
            source: "vm0-local-browser-extension",
            type: "vm0.localBrowser.detected",
            requestId,
            browser: "Chrome",
            extensionVersion: "0.1.0",
          }
        : request.type === "vm0.localBrowser.pair"
          ? {
              source: "vm0-local-browser-extension",
              type: "vm0.localBrowser.pairingStarted",
              requestId,
              deviceCode: "device-code-123",
            }
          : null;
    if (!response) {
      return;
    }

    queueMicrotask(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: response,
          origin: window.location.origin,
          source: window,
        }),
      );
    });
  });
  signal.addEventListener(
    "abort",
    () => {
      postMessageSpy.mockRestore();
    },
    { once: true },
  );
}

describe("local-browser connector", () => {
  it("is hidden when the local-browser feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.LocalBrowserUse]: false },
    });

    const connectors = await context.store.get(allConnectorTypes$);

    expect(
      connectors.some((connector) => {
        return connector.type === "local-browser";
      }),
    ).toBeFalsy();
  });

  it("shows online browser hosts without treating them as connected", async () => {
    setMockLocalBrowserHosts([
      {
        id: "browser-online",
        displayName: "Work browser",
        browser: "Chrome",
        extensionVersion: "0.1.0",
        supportedCapabilities: ["tabs.list", "page.snapshot"],
        status: "online",
        lastSeenAt: "2026-05-12T00:00:00.000Z",
        createdAt: "2026-05-12T00:00:00.000Z",
      },
      {
        id: "browser-offline",
        displayName: "Old browser",
        browser: "Edge",
        extensionVersion: "0.1.0",
        supportedCapabilities: ["tabs.list"],
        status: "offline",
        lastSeenAt: "2026-05-11T00:00:00.000Z",
        createdAt: "2026-05-11T00:00:00.000Z",
      },
    ]);
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.LocalBrowserUse]: true },
    });

    const connectors = await context.store.get(allConnectorTypes$);
    const localBrowser = connectors.find((connector) => {
      return connector.type === "local-browser";
    });

    expect(localBrowser?.availableAuthMethods).toStrictEqual(["api"]);
    expect(localBrowser?.connected).toBeFalsy();
    expect(localBrowser?.localBrowserHosts).toStrictEqual([
      expect.objectContaining({
        id: "browser-online",
        displayName: "Work browser",
      }),
    ]);
  });

  it("pairs the browser extension through the web bridge", async () => {
    installLocalBrowserExtensionResponder(context.signal);
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.LocalBrowserUse]: true },
    });

    await context.store.set(pairLocalBrowserExtension$, context.signal);

    expect(getMockClaimedLocalBrowserDeviceCodes()).toStrictEqual([
      "device-code-123",
    ]);
    expect(context.store.get(localBrowserExtensionStatus$).status).toBe(
      "available",
    );
  });

  it("opens the agent auth dialog after connecting from settings", async () => {
    setMockLocalBrowserHosts([
      {
        id: "browser-online",
        displayName: "Work browser",
        browser: "Chrome",
        extensionVersion: "0.1.0",
        supportedCapabilities: ["tabs.list", "page.snapshot"],
        status: "online",
        lastSeenAt: "2026-05-12T00:00:00.000Z",
        createdAt: "2026-05-12T00:00:00.000Z",
      },
    ]);
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.LocalBrowserUse]: true },
    });

    await context.store.set(
      connectLocalBrowserConnector$,
      { showPermissionDialog: true },
      context.signal,
    );

    expect(context.store.get(permissionDialogType$)).toBe("local-browser");
  });
});
