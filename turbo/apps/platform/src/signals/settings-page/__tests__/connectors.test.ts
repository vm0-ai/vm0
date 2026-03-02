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
      ]),
    );
  });

  it("should hide computer connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { computerConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const computerConnector = types.find((t) => t.type === "computer");

    expect(computerConnector).toBeUndefined();
  });

  it("should hide docusign connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { docusignConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const docusignConnector = types.find((t) => t.type === "docusign");

    expect(docusignConnector).toBeUndefined();
  });

  it("should hide dropbox connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { dropboxConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const dropboxConnector = types.find((t) => t.type === "dropbox");

    expect(dropboxConnector).toBeUndefined();
  });

  it("should hide deel connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { deelConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const deelConnector = types.find((t) => t.type === "deel");

    expect(deelConnector).toBeUndefined();
  });

  it("should hide figma connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { figmaConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const figmaConnector = types.find((t) => t.type === "figma");

    expect(figmaConnector).toBeUndefined();
  });

  it("should hide google-sheets connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { googleSheetsConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const googleSheetsConnector = types.find((t) => t.type === "google-sheets");

    expect(googleSheetsConnector).toBeUndefined();
  });

  it("should hide google-docs connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { googleDocsConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const googleDocsConnector = types.find((t) => t.type === "google-docs");

    expect(googleDocsConnector).toBeUndefined();
  });

  it("should hide google-drive connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { googleDriveConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const googleDriveConnector = types.find((t) => t.type === "google-drive");

    expect(googleDriveConnector).toBeUndefined();
  });

  it("should hide mercury connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { mercuryConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const mercuryConnector = types.find((t) => t.type === "mercury");

    expect(mercuryConnector).toBeUndefined();
  });

  it("should hide strava connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { stravaConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const stravaConnector = types.find((t) => t.type === "strava");

    expect(stravaConnector).toBeUndefined();
  });

  it("should hide garmin-connect connector when feature flag is disabled", async () => {
    const { store } = context;

    await setupPage({
      context,
      path: "/",
      withoutRender: true,
      featureSwitches: { garminConnectConnector: false },
    });

    const types = await store.get(allConnectorTypes$);
    const garminConnector = types.find((t) => t.type === "garmin-connect");

    expect(garminConnector).toBeUndefined();
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
