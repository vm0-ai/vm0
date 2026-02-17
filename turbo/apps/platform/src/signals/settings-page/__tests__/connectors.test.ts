import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import {
  allConnectorTypes$,
  openDisconnectDialog$,
  confirmDisconnect$,
  disconnectDialogState$,
} from "../connectors";
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
