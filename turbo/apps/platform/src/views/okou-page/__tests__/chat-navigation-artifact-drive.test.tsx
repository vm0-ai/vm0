import type { ArtifactDetail } from "@okouai/api-contracts/contracts/artifact-catalog";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  connectorOauthStartContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  userConnectorsContract,
  type UserConnectorUpdate,
} from "@okouai/api-contracts/contracts/user-connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  GOOGLE_DRIVE_CONNECTION_ID,
  googleDriveCatalogItem,
  googleDriveConnector,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_AGENT_ID,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();

const DRIVE_ARTIFACT_ID = "a0000000-0000-4000-a000-000000000940";
const DRIVE_FILE_ID = "f0000000-0000-4000-a000-000000000940";
const DRIVE_FILE_URL = "https://files.example.test/drive-report.pdf";
const AUTHORIZATION_URL = "https://accounts.google.test/authorize-drive";

type DriveConnectionState =
  | "not-connected"
  | ConnectorResponse["connectionStatus"];

interface OauthRequest {
  readonly account: ConnectorAccountMutationIntent;
  readonly agentId?: string;
  readonly authMethod: string;
  readonly authorizeAgent?: true;
  readonly callbackTarget?: "app";
}

interface DriveMockControl {
  readonly authorizationUpdates: readonly UserConnectorUpdate[];
  readonly completeAuthorization: () => void;
  readonly oauthRequests: readonly OauthRequest[];
  readonly syncRequests: readonly {
    readonly fileId: string;
    readonly runId: string;
  }[];
}

function installDriveMocks(
  targetContext: TestContext,
  initialConnectionState: DriveConnectionState,
): DriveMockControl {
  let connectionState = initialConnectionState;
  let agentAuthorized = false;
  let artifactSynced = false;
  const authorizationUpdates: UserConnectorUpdate[] = [];
  const oauthRequests: OauthRequest[] = [];
  const syncRequests: { fileId: string; runId: string }[] = [];

  const summary = artifactSummary(
    DRIVE_ARTIFACT_ID,
    "file",
    "Drive report.pdf",
  );
  const details = new Map<string, ArtifactDetail>([
    [
      DRIVE_ARTIFACT_ID,
      fileArtifactDetail(summary, {
        contentType: "application/pdf",
        fileId: DRIVE_FILE_ID,
        filename: "drive-report.pdf",
        url: DRIVE_FILE_URL,
      }),
    ],
  ]);
  mockArtifactConversation(targetContext, {
    catalog: [summary],
    details,
    artifactRuns: () => {
      return [
        artifactRun({
          contentType: "application/pdf",
          fileId: DRIVE_FILE_ID,
          filename: "drive-report.pdf",
          url: DRIVE_FILE_URL,
          googleDriveSync: artifactSynced
            ? {
                status: "synced",
                id: "drive-file-1",
                name: "drive-report.pdf",
                webViewLink: "https://drive.google.test/file/drive-file-1",
              }
            : { status: "disconnected" },
        }),
      ];
    },
  });

  targetContext.mocks.api(connectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors:
        connectionState === "not-connected"
          ? []
          : [googleDriveConnector(connectionState)],
      connectorProvidedBindings: [],
    });
  });
  targetContext.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [googleDriveCatalogItem(connectionState)],
    });
  });
  targetContext.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: agentAuthorized ? ["google-drive"] : [],
    });
  });
  targetContext.mocks.api(
    userConnectorsContract.update,
    ({ body, respond }) => {
      authorizationUpdates.push(body);
      agentAuthorized = true;
      return respond(200, { enabledConnectorSlugs: ["google-drive"] });
    },
  );
  targetContext.mocks.api(
    connectorOauthStartContract.start,
    ({ body, respond }) => {
      oauthRequests.push(body);
      return respond(200, {
        authorizationUrl: AUTHORIZATION_URL,
        connectionId: GOOGLE_DRIVE_CONNECTION_ID,
      });
    },
  );
  targetContext.mocks.api(
    chatThreadArtifactsContract.syncGoogleDrive,
    ({ body, respond }) => {
      syncRequests.push(body);
      artifactSynced = true;
      return respond(200, {
        id: "drive-file-1",
        name: "drive-report.pdf",
        webViewLink: "https://drive.google.test/file/drive-file-1",
      });
    },
  );

  return {
    authorizationUpdates,
    completeAuthorization: () => {
      connectionState = "connected";
      agentAuthorized = true;
      targetContext.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });
    },
    oauthRequests,
    syncRequests,
  };
}

interface AuthorizationPopupMock {
  readonly location: { href: string };
  readonly open: ReturnType<TestContext["mocks"]["browser"]["open"]>;
}

function installAuthorizationPopup(): AuthorizationPopupMock {
  const authorizationWindow = context.mocks.browser.authWindow();
  const location = { href: "about:blank" };
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: location,
  });
  return {
    location,
    open: context.mocks.browser.open(authorizationWindow),
  };
}

function useWideScreen(): void {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 1280px)";
  });
}

function artifactList(): HTMLElement {
  return screen.getByTestId("thread-sidebar-artifacts");
}

function artifactPreview(): HTMLElement {
  return screen.getByTestId("artifact-sidebar");
}

async function openDriveArtifactMenu(): Promise<void> {
  await waitFor(() => {
    expect(buttonNamed("Open artifacts")).toBeVisible();
  });
  click(buttonNamed("Open artifacts"));
  await waitFor(() => {
    expect(
      buttonNamed("Preview Drive report.pdf", artifactList()),
    ).toBeVisible();
  });
  click(buttonNamed("Preview Drive report.pdf", artifactList()));
  await waitFor(() => {
    expect(buttonNamed("Download artifact", artifactPreview())).toBeVisible();
  });
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(roleItemNamed("menuitem", "Connect Google Drive")).toBeEnabled();
  });
}

async function expectSyncedPreview(): Promise<void> {
  await waitFor(() => {
    expect(buttonNamed("Download artifact", artifactPreview())).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  click(buttonNamed("Download artifact", artifactPreview()));
  await waitFor(() => {
    expect(roleItemNamed("menuitem", "Synced to Google Drive")).toBeVisible();
    expect(roleItemNamed("menuitem", "Synced to Google Drive")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
}

test("Authorize the agent and sync an artifact to connected Google Drive", async () => {
  useWideScreen();
  const drive = installDriveMocks(context, "connected");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.vm0.ai",
  });

  await openDriveArtifactMenu();
  click(roleItemNamed("menuitem", "Connect Google Drive"));

  await waitFor(() => {
    expect(drive.authorizationUpdates).toStrictEqual([
      {
        enabledConnectorSlugs: ["google-drive"],
        operation: "add",
      },
    ]);
    expect(drive.syncRequests).toStrictEqual([
      { runId: NAVIGATION_ARTIFACT_RUN_ID, fileId: DRIVE_FILE_ID },
    ]);
    expect(drive.oauthRequests).toHaveLength(0);
  });
  await expectSyncedPreview();
});

test("Connect Google Drive and sync an artifact", async () => {
  useWideScreen();
  const authorizationPopup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "not-connected");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.vm0.ai",
  });

  await openDriveArtifactMenu();
  click(roleItemNamed("menuitem", "Connect Google Drive"));

  await waitFor(() => {
    expect(authorizationPopup.open.calls).toStrictEqual([
      {
        url: "about:blank",
        target: "_blank",
        features: "width=600,height=700",
      },
    ]);
    expect(drive.oauthRequests).toStrictEqual([
      {
        account: { intent: "add" },
        authMethod: "oauth",
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        authorizeAgent: true,
        callbackTarget: "app",
      },
    ]);
    expect(authorizationPopup.location.href).toBe(AUTHORIZATION_URL);
  });

  drive.completeAuthorization();
  await waitFor(() => {
    expect(drive.syncRequests).toStrictEqual([
      { runId: NAVIGATION_ARTIFACT_RUN_ID, fileId: DRIVE_FILE_ID },
    ]);
  });
  await expectSyncedPreview();
});

test("Reconnect Google Drive and sync an artifact", async () => {
  useWideScreen();
  const authorizationPopup = installAuthorizationPopup();
  const drive = installDriveMocks(context, "reconnect-required");

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.vm0.ai",
  });

  await openDriveArtifactMenu();
  click(roleItemNamed("menuitem", "Connect Google Drive"));

  await waitFor(() => {
    expect(authorizationPopup.open.calls).toStrictEqual([
      {
        url: "about:blank",
        target: "_blank",
        features: "width=600,height=700",
      },
    ]);
    expect(drive.oauthRequests).toStrictEqual([
      {
        account: {
          intent: "reconnect",
          connectionId: GOOGLE_DRIVE_CONNECTION_ID,
        },
        authMethod: "oauth",
        agentId: NAVIGATION_ARTIFACT_AGENT_ID,
        authorizeAgent: true,
        callbackTarget: "app",
      },
    ]);
    expect(authorizationPopup.location.href).toBe(AUTHORIZATION_URL);
  });

  drive.completeAuthorization();
  await waitFor(() => {
    expect(drive.syncRequests).toStrictEqual([
      { runId: NAVIGATION_ARTIFACT_RUN_ID, fileId: DRIVE_FILE_ID },
    ]);
  });
  await expectSyncedPreview();
});
