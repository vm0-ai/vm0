import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { mockedNango, triggerNangoEvent } from "../../../__tests__/mock-nango";
import {
  allConnectorTypes$,
  connectConnector$,
  openDisconnectDialog$,
  confirmDisconnect$,
  disconnectDialogState$,
  pollingConnectorType$,
} from "../connectors";
import { connectors$ } from "../../external/connectors";
import { server } from "../../../mocks/server";
import { http, HttpResponse } from "msw";

const context = testContext();

describe("allConnectorTypes$", () => {
  it("should list all connector types with connected status", async () => {
    const { store } = context;

    // Mock API to return one connected connector
    server.use(
      http.get("/api/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: "conn-1",
              type: "github",
              authMethod: "oauth",
              platform: "self-hosted",
              externalUsername: "octocat",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { connectorNango: true },
    });

    const types = await store.get(allConnectorTypes$);

    expect(types).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "github",
          connected: true,
          label: "GitHub",
        }),
        expect.objectContaining({
          type: "notion",
          connected: false,
          label: "Notion",
        }),
        expect.objectContaining({
          type: "gmail",
          connected: false,
          label: "Gmail",
        }),
      ]),
    );
  });

  it("should hide computer connector when feature flag is disabled", async () => {
    const { store } = context;

    server.use(
      http.get("/api/feature-switches", () => {
        return HttpResponse.json({ computerConnector: false });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const types = await store.get(allConnectorTypes$);
    const computerConnector = types.find((t) => t.type === "computer");

    expect(computerConnector).toBeUndefined();
  });
});

describe("connectConnector$", () => {
  it("should create connect session and open nango UI", async () => {
    const { store, signal } = context;

    // Mock create-session endpoint
    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return HttpResponse.json({
          sessionToken: "ncs_test_token",
        });
      }),
    );

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { connectorNango: true },
    });

    // Start connection flow
    await store.set(connectConnector$, "gmail", signal);

    // Verify Nango UI was opened with correct session token
    expect(mockedNango.openConnectUI).toHaveBeenCalledWith({
      sessionToken: "ncs_test_token",
      onEvent: expect.any(Function),
    });

    // Verify polling state
    expect(store.get(pollingConnectorType$)).toBe("gmail");
  });

  it("should handle connection success event", async () => {
    const { store, signal } = context;

    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return HttpResponse.json({ sessionToken: "test" });
      }),
      http.get("/api/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: "new-conn",
              type: "gmail",
              authMethod: "oauth",
              platform: "nango",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { connectorNango: true },
    });
    await store.set(connectConnector$, "gmail", signal);

    // Simulate connection success
    await triggerNangoEvent({ type: "connect" });

    // Polling should stop
    expect(store.get(pollingConnectorType$)).toBeNull();

    // Connectors should be reloaded
    const connectors = await store.get(connectors$);
    expect(connectors.connectors).toHaveLength(1);
    expect(connectors.connectors[0].type).toBe("gmail");
  });

  it("should handle user closing modal", async () => {
    const { store, signal } = context;

    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return HttpResponse.json({ sessionToken: "test" });
      }),
    );

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { connectorNango: true },
    });
    await store.set(connectConnector$, "gmail", signal);

    // Simulate user closing
    await triggerNangoEvent({ type: "close" });

    // Polling should stop
    expect(store.get(pollingConnectorType$)).toBeNull();
  });

  it("should handle session creation errors", async () => {
    const { store, signal } = context;

    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { connectorNango: true },
    });

    // Connection attempt should not throw, but handle error gracefully
    await store.set(connectConnector$, "gmail", signal);

    // Polling should stop on error
    expect(store.get(pollingConnectorType$)).toBeNull();

    // Nango UI should not have been opened
    expect(mockedNango.openConnectUI).not.toHaveBeenCalled();
  });
});

describe("disconnect dialog", () => {
  it("should open disconnect dialog", async () => {
    const { store } = context;

    await setupPage({ context, path: "/", withoutRender: true });

    // Open dialog
    await store.set(openDisconnectDialog$, "github");

    const dialogState = store.get(disconnectDialogState$);
    expect(dialogState.open).toBeTruthy();
    expect(dialogState.connectorType).toBe("github");
  });

  it("should disconnect connector successfully", async () => {
    const { store, signal } = context;

    server.use(
      http.delete("/api/connectors/github", () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/connectors", () => {
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Open dialog and confirm
    await store.set(openDisconnectDialog$, "github");
    await store.set(confirmDisconnect$, signal);

    // Dialog should close
    const dialogState = store.get(disconnectDialogState$);
    expect(dialogState.open).toBeFalsy();
    expect(dialogState.connectorType).toBeNull();
  });

  it("should handle disconnect errors", async () => {
    const { store, signal } = context;

    server.use(
      http.delete("/api/connectors/github", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await store.set(openDisconnectDialog$, "github");

    await expect(store.set(confirmDisconnect$, signal)).rejects.toThrow();
  });
});
