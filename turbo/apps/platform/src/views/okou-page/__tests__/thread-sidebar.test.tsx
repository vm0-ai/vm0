import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadMarkReadContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
} from "@okouai/api-contracts/contracts/chat-threads";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorOauthStartContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  chatEventRowsResponse,
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "../../../signals/chat-page/chat-thread-sidebar-layout.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

const context = testContext();
warmMermaidParser();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000001";
const SELECTED_DRIVE_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

type OfficePreviewFixture = {
  readonly filename: string;
  readonly kindLabel: string;
};

const officePreviewFixtures: readonly OfficePreviewFixture[] = [
  { filename: "brief.doc", kindLabel: "Document" },
  { filename: "brief.docm", kindLabel: "Document" },
  { filename: "brief.docx", kindLabel: "Document" },
  { filename: "brief.dot", kindLabel: "Document" },
  { filename: "brief.dotm", kindLabel: "Document" },
  { filename: "brief.dotx", kindLabel: "Document" },
  { filename: "brief.odt", kindLabel: "Document" },
  { filename: "metrics.ods", kindLabel: "Data" },
  { filename: "metrics.xls", kindLabel: "Data" },
  { filename: "metrics.xlsb", kindLabel: "Data" },
  { filename: "metrics.xlsm", kindLabel: "Data" },
  { filename: "metrics.xlsx", kindLabel: "Data" },
  { filename: "launch.odp", kindLabel: "Presentation" },
  { filename: "launch.pot", kindLabel: "Presentation" },
  { filename: "launch.potm", kindLabel: "Presentation" },
  { filename: "launch.potx", kindLabel: "Presentation" },
  { filename: "launch.pps", kindLabel: "Presentation" },
  { filename: "launch.ppsm", kindLabel: "Presentation" },
  { filename: "launch.ppsx", kindLabel: "Presentation" },
  { filename: "launch.ppt", kindLabel: "Presentation" },
  { filename: "launch.pptm", kindLabel: "Presentation" },
  { filename: "launch.pptx", kindLabel: "Presentation" },
  { filename: "FORECAST.XLSX", kindLabel: "Data" },
] as const;

const unsupportedOfficePreviewFilenames = [
  "archive.xlt",
  "archive.xltx",
  "archive.xltm",
  "archive.xlm",
  "archive.ppa",
  "archive.ppam",
  "archive.rtf",
  "archive.one",
  "archive.zip",
] as const;

function browserSession(
  overrides: Partial<BrowserSession> = {},
): BrowserSession {
  return {
    threadId: THREAD_ID,
    name: "Thread browser",
    status: "active",
    viewerUrl: `https://app.vm0.ai/browsers/${THREAD_ID}`,
    liveUrl: "https://live.browser-use.com/?wss=thread-browser",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: "2026-03-10T00:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
    ...overrides,
  };
}

function catalogArtifact(
  overrides: Partial<ArtifactSummary> = {},
): ArtifactSummary {
  return {
    id: ARTIFACT_ID,
    kind: "file",
    title: "launch-plan.txt",
    thumbnail: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function catalogFileDetail({
  contentType,
  filename,
  fileId,
  summary,
  url,
}: {
  contentType: string;
  filename: string;
  fileId: string;
  summary: ArtifactSummary;
  url: string;
}): ArtifactDetail {
  return {
    ...summary,
    kind: "file",
    file: {
      id: fileId,
      filename,
      contentType,
      size: 1024,
      url,
      previewImageUrl: null,
    },
  };
}

function threadArtifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-release-notes",
    filename: "release-notes.md",
    contentType: "text/markdown",
    size: 42,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

function officeUserFileMessages(
  fileId: string,
  filename: string,
): MockChatEventInput[] {
  return [
    {
      id: `msg-${fileId}`,
      role: "user",
      content: "Review this Office document",
      fileParts: [
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
      runId: "run-sidebar",
      seqId: 1,
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: `msg-${fileId}-completed`,
      role: "assistant",
      content: null,
      runId: "run-sidebar",
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];
}

function googleDriveConnector(
  overrides: Partial<ConnectorResponse> = {},
): ConnectorResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "google-drive",
    authMethod: "oauth",
    externalId: "google-drive-external-id",
    externalUsername: "drive-user",
    externalEmail: "drive-user@example.com",
    oauthScopes: ["drive.file"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function googleDriveAccountConnection(
  overrides: Partial<ConnectorAccountConnection> = {},
): ConnectorAccountConnection {
  return {
    id: SELECTED_DRIVE_CONNECTION_ID,
    target: { kind: "builtin", connectorSlug: "google-drive" },
    authMethod: "oauth",
    displayName: "Selected Drive",
    isDefault: false,
    externalId: "selected-drive-external-id",
    externalUsername: "selected-drive-user",
    externalEmail: "selected-drive@example.test",
    oauthScopes: ["drive.file"],
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function googleDriveCatalogStatus(
  overrides: Partial<PublicConnectorCatalogStatusItem> = {},
): PublicConnectorCatalogStatusItem {
  return {
    slug: "google-drive",
    label: "Google Drive",
    description: "Store artifacts in Google Drive",
    icon: {
      url: "https://icons.example.test/google-drive.svg",
      invertInDarkMode: false,
    },
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
    ...overrides,
  };
}

function setupArtifactCatalog(
  artifacts: ArtifactSummary[],
  details: ReadonlyMap<string, ArtifactDetail>,
): void {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts, nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const detail = details.get(params.artifactId);
    if (!detail) {
      return respond(404, {
        error: { message: "Artifact not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, detail);
  });
}

function setupChatThread({
  artifactFiles = [],
  featureSwitches = {},
  messages = [
    {
      id: "msg-sidebar-user",
      threadId: THREAD_ID,
      eventType: "input.prompt",
      role: "user",
      content: "Build the launch plan",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Build the launch plan" }],
      },
      runId: "run-sidebar",
      seqId: 1,
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-sidebar-completed",
      threadId: THREAD_ID,
      eventType: "run.completed",
      content: null,
      runId: "run-sidebar",
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ],
}: {
  artifactFiles?: ChatThreadArtifactFile[];
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  messages?: MockChatEventInput[];
} = {}) {
  let servedMessages = [...messages];
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Sidebar thread",
          sortAt: "2026-03-10T00:00:02Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:02Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: "00000000-0000-4000-8000-000000000001",
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    const events = normalizeMockChatEvents(
      servedMessages.map((message) => {
        return { ...message, threadId: message.threadId ?? THREAD_ID };
      }),
    );
    return respond(
      200,
      chatEventRowsResponse(
        mockChatEventRows(events).filter((row) => {
          return row.seqId > query.sinceSeqId;
        }),
        query,
      ),
    );
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [{ runId: "run-sidebar", files: artifactFiles }],
    });
  });

  detachedSetupPage({
    context,
    featureSwitches,
    path: THREAD_PATH,
  });

  return {
    publishMessages(nextMessages: MockChatEventInput[]): void {
      servedMessages = [...servedMessages, ...nextMessages];
      const syncThroughSeqId = nextMessages.at(-1)?.seqId;
      if (syncThroughSeqId === undefined) {
        throw new Error("Published chat messages need a seqId");
      }
      createChatEvent(THREAD_ID, { syncThroughSeqId });
    },
  };
}

function setupOfficePreviewAttachment(filename: string): string {
  const url = `https://cdn.vm7.io/artifacts/test/run-sidebar/${encodeURIComponent(filename)}`;
  setupChatThread({
    artifactFiles: [
      threadArtifactFile(url, {
        id: `artifact-${filename}`,
        filename,
        contentType: "application/octet-stream",
      }),
    ],
    messages: [
      {
        id: `msg-${filename}`,
        role: "assistant",
        content: `[${filename}](${url})`,
        runId: "run-sidebar",
        seqId: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: `msg-${filename}-completed`,
        role: "assistant",
        content: null,
        runId: "run-sidebar",
        runLifecycleEvent: "completed",
        seqId: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ],
    featureSwitches: {
      [FeatureSwitchKey.OfficeDocumentPreview]: true,
    },
  });
  return url;
}

async function openArtifactsFromHeader(): Promise<void> {
  const button = await waitFor(() => {
    const found = queryAllByRoleFast("button").find((element) => {
      return element.getAttribute("aria-label") === "Open artifacts";
    });
    if (!found) {
      throw new Error("Expected the artifacts header button");
    }
    return found;
  });
  click(button);
}

async function openCatalogArtifact(title: string): Promise<void> {
  await openArtifactsFromHeader();
  click(await screen.findByLabelText(`Preview ${title}`));
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
  });
}

function menuItemByText(text: string): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

describe("thread-owned utility sidebar", () => {
  it("always opens the thread browser from the header", async () => {
    context.mocks.api(browserContract.get, ({ params, respond }) => {
      expect(params.threadId).toBe(THREAD_ID);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Browser not found" },
      });
    });
    setupChatThread();

    const button = await screen.findByLabelText("Open browser");
    expect(button).toHaveAttribute("aria-pressed", "false");
    click(button);

    await expect(
      screen.findByText("Browser not live"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("Start browser"),
    ).resolves.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("optimistically opens the browser and records sidebar close with caller event IDs", async () => {
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Browser not found" },
      });
    });
    let startEventId: string | null = null;
    context.mocks.api(browserContract.open, ({ body, params, respond }) => {
      expect(params.threadId).toBe(THREAD_ID);
      startEventId = body.eventId;
      return respond(200, {
        browser: browserSession(),
        lifecycleEventId: body.eventId,
      });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: browserSession({ liveUrl: null }) });
    });
    const finishClose = context.mocks.deferred<void>();
    let closeEventId: string | null = null;
    context.mocks.api(
      browserContract.close,
      async ({ body, params, respond }) => {
        expect(params.threadId).toBe(THREAD_ID);
        closeEventId = body.eventId;
        await finishClose.promise;
        return respond(200, {
          lifecycleEventId: body.eventId,
        });
      },
    );
    setupChatThread();

    click(await screen.findByLabelText("Open browser"));
    click(await screen.findByText("Start browser"));
    await screen.findByTitle("Live browser: Thread browser");
    expect(startEventId).toBeTypeOf("string");

    expect(screen.queryByLabelText("Stop browser")).not.toBeInTheDocument();
    click(screen.getByLabelText("Close live browser"));
    await waitFor(() => {
      expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
      expect(closeEventId).toBeTypeOf("string");
    });
    expect(closeEventId).not.toBe(startEventId);
    finishClose.resolve();
  });

  it("opens the thread-scoped catalog list", async () => {
    const requestedThreadIds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedThreadIds.push(query.chatThreadId);
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });

    setupChatThread();
    await openArtifactsFromHeader();

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });
    await screen.findByLabelText("Preview launch-plan.txt");
    expect(requestedThreadIds).toContain(THREAD_ID);
  });

  it.each(officePreviewFixtures)(
    "previews $filename in the dialog and split view",
    async ({ filename, kindLabel }) => {
      const url = setupOfficePreviewAttachment(filename);

      const card = await screen.findByLabelText(`Preview ${filename}`);
      expect(
        screen.queryByLabelText(`Download ${filename}`),
      ).not.toBeInTheDocument();
      click(card);

      const dialog = await screen.findByTestId("attachment-lightbox");
      expect(
        within(dialog).getByText((content) => {
          return content.startsWith(`${kindLabel} ·`);
        }),
      ).toBeInTheDocument();
      const dialogFrame = await within(dialog).findByTitle(
        `${filename} preview`,
      );
      const dialogFrameUrl = dialogFrame.getAttribute("src");
      expect(dialogFrameUrl).not.toBeNull();
      if (dialogFrameUrl === null) {
        throw new Error("Office preview iframe is missing its source URL");
      }
      const parsedDialogFrameUrl = new URL(dialogFrameUrl);
      expect(parsedDialogFrameUrl.origin).toBe(
        "https://view.officeapps.live.com",
      );
      expect(parsedDialogFrameUrl.pathname).toBe("/op/embed.aspx");
      expect(parsedDialogFrameUrl.searchParams.get("src")).toBe(url);

      click(within(dialog).getByLabelText("Open in split view"));

      await waitFor(() => {
        expect(
          screen.queryByTestId("attachment-lightbox"),
        ).not.toBeInTheDocument();
      });
      const sidebar = await screen.findByTestId("artifact-sidebar");
      const sidebarFrame = await within(sidebar).findByTitle(
        `${filename} preview`,
      );
      const sidebarFrameUrl = sidebarFrame.getAttribute("src");
      expect(sidebarFrameUrl).not.toBeNull();
      if (sidebarFrameUrl === null) {
        throw new Error("Office split-view iframe is missing its source URL");
      }
      expect(new URL(sidebarFrameUrl).searchParams.get("src")).toBe(url);
    },
  );

  it.each(unsupportedOfficePreviewFilenames)(
    "keeps unsupported %s files on the generic preview",
    async (filename) => {
      setupOfficePreviewAttachment(filename);

      click(await screen.findByLabelText(`Preview ${filename}`));

      const dialog = await screen.findByTestId("attachment-lightbox");
      expect(
        within(dialog).getByText("No inline preview available for this file."),
      ).toBeInTheDocument();
      expect(within(dialog).queryByTitle(`${filename} preview`)).toBeNull();

      click(within(dialog).getByLabelText("Open in split view"));

      const sidebar = await screen.findByTestId("artifact-sidebar");
      expect(
        within(sidebar).getByText("No inline preview available for this file."),
      ).toBeInTheDocument();
      expect(within(sidebar).queryByTitle(`${filename} preview`)).toBeNull();
    },
  );

  it("uses the public office attachment url instead of its presigned resource url", async () => {
    const filename = "private-manuscript.docx";
    const fileId = "office-with-distinct-public-url";
    const resourceUrl = `https://r2.example.com/artifacts/${filename}?sig=test`;
    const shareUrl = `https://cdn.vm7.io/artifacts/test/run-sidebar/${filename}`;
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      expect(query.file_id).toBe(fileId);
      return respond(200, { url: resourceUrl, publicUrl: shareUrl });
    });
    setupChatThread({
      featureSwitches: {
        [FeatureSwitchKey.OfficeDocumentPreview]: true,
      },
      messages: officeUserFileMessages(fileId, filename),
    });

    click(await screen.findByLabelText(`Preview ${filename}`));

    const dialog = await screen.findByTestId("attachment-lightbox");
    const dialogFrame = await within(dialog).findByTitle(`${filename} preview`);
    const dialogFrameUrl = dialogFrame.getAttribute("src");
    expect(dialogFrameUrl).not.toBeNull();
    if (dialogFrameUrl === null) {
      throw new Error("Office preview iframe is missing its source URL");
    }
    expect(new URL(dialogFrameUrl).searchParams.get("src")).toBe(shareUrl);
    expect(new URL(dialogFrameUrl).searchParams.get("src")).not.toBe(
      resourceUrl,
    );

    click(within(dialog).getByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    const sidebarFrame = await within(sidebar).findByTitle(
      `${filename} preview`,
    );
    const sidebarFrameUrl = sidebarFrame.getAttribute("src");
    expect(sidebarFrameUrl).not.toBeNull();
    if (sidebarFrameUrl === null) {
      throw new Error("Office split-view iframe is missing its source URL");
    }
    expect(new URL(sidebarFrameUrl).searchParams.get("src")).toBe(shareUrl);
    expect(new URL(sidebarFrameUrl).searchParams.get("src")).not.toBe(
      resourceUrl,
    );
  });

  it("keeps office files on the generic preview when the feature switch is disabled", async () => {
    const filename = "revised-manuscript.docx";
    const url = `https://cdn.vm7.io/artifacts/test/run-sidebar/${filename}`;
    setupChatThread({
      artifactFiles: [
        threadArtifactFile(url, {
          id: "artifact-office-disabled",
          filename,
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ],
      featureSwitches: {
        [FeatureSwitchKey.OfficeDocumentPreview]: false,
      },
      messages: [
        {
          id: "msg-office-disabled",
          role: "assistant",
          content: `[${filename}](${url})`,
          runId: "run-sidebar",
          seqId: 1,
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-office-disabled-completed",
          role: "assistant",
          content: null,
          runId: "run-sidebar",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
    });

    click(await screen.findByLabelText(`Preview ${filename}`));

    const dialog = await screen.findByTestId("attachment-lightbox");
    expect(
      within(dialog).getByText("No inline preview available for this file."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByTitle(`${filename} preview`)).toBeNull();

    click(within(dialog).getByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    expect(
      within(sidebar).getByText("No inline preview available for this file."),
    ).toBeInTheDocument();
    expect(within(sidebar).queryByTitle(`${filename} preview`)).toBeNull();
  });

  it("does not send a presigned office attachment url to the viewer when the api omits its public url", async () => {
    const filename = "legacy-api-document.docx";
    const fileId = "office-without-public-url";
    const resourceUrl = `https://r2.example.com/artifacts/${filename}?sig=test`;
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      expect(query.file_id).toBe(fileId);
      return respond(200, { url: resourceUrl });
    });
    setupChatThread({
      featureSwitches: {
        [FeatureSwitchKey.OfficeDocumentPreview]: true,
      },
      messages: officeUserFileMessages(fileId, filename),
    });

    click(await screen.findByLabelText(`Preview ${filename}`));

    const dialog = await screen.findByTestId("attachment-lightbox");
    await expect(
      within(dialog).findByText("Preview unavailable."),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByTitle(`${filename} preview`)).toBeNull();

    click(within(dialog).getByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    await expect(
      within(sidebar).findByText("Preview unavailable."),
    ).resolves.toBeInTheDocument();
    expect(within(sidebar).queryByTitle(`${filename} preview`)).toBeNull();
  });

  it("previews a public catalog document through the resolved resource url", async () => {
    const htmlUrl = "https://catalog-document.sites.vm7.io";
    const summary = catalogArtifact({ title: "launch-site.html" });
    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/html",
            filename: "launch-site.html",
            fileId: "f0000000-0000-4000-a000-000000000003",
            summary,
            url: htmlUrl,
          }),
        ],
      ]),
    );

    setupChatThread();
    await openCatalogArtifact("launch-site.html");

    // A public URL resolves to itself, so the same path that presigns a private
    // attachment leaves a hosted site untouched.
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        htmlUrl,
      );
    });
  });

  it("shows an unavailable artifact detail with a way back to the list", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(404, {
        error: { message: "Artifact not found", code: "NOT_FOUND" },
      });
    });

    setupChatThread();
    await openArtifactsFromHeader();
    click(await screen.findByLabelText("Preview launch-plan.txt"));

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifact-unavailable"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Back to artifacts"));
    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });
  });

  it("releases a markdown diagram URL when its sidebar preview is replaced", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/diagram-notes.md";
    const summary = catalogArtifact({ title: "diagram-notes.md" });
    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/markdown",
            filename: "diagram-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000002",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.http.get(markdownUrl, () => {
      return new Response("```mermaid\nflowchart TD\n  A --> B\n```", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    setupChatThread();
    await openCatalogArtifact("diagram-notes.md");

    const diagram = await screen.findByAltText("Diagram");
    const url = diagram.getAttribute("src") ?? "";
    const expand = screen.getByLabelText("Expand diagram");
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });
    click(expand);

    const sidebar = await screen.findByTestId("artifact-sidebar");
    const sidebarImage = await waitFor(() => {
      return within(sidebar).getByTestId("artifact-sidebar-body-image");
    });
    const sidebarUrl = sidebarImage.getAttribute("src") ?? "";
    expect(sidebarUrl).toContain("blob:mock-download-");
    expect(sidebarUrl).not.toBe(url);
    expect(sidebarImage).toHaveAttribute("alt", "diagram.svg");
    expect(objectUrls.revokedUrls).toContain(url);
    expect(objectUrls.revokedUrls).not.toContain(sidebarUrl);
    expect(context.signal.aborted).toBeFalsy();
  });

  it("connects the agent and syncs a catalog artifact to Google Drive", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-agent-notes.md";
    const summary = catalogArtifact({ title: "drive-agent-notes.md" });
    const artifactFiles = [
      threadArtifactFile(markdownUrl, {
        id: "artifact-drive-agent-notes",
        filename: "drive-agent-notes.md",
        googleDriveSync: {
          status: "disconnected",
          recovery: { action: "authorize" },
        },
      }),
    ];

    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/markdown",
            filename: "drive-agent-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000001",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.data.connectors([
      googleDriveConnector({
        id: "22222222-2222-4222-8222-222222222222",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
      googleDriveConnector(),
    ]);
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [] });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Agent notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    let enabledConnectorSlugs: string[] = [];
    let agentAuthorized = false;
    let artifactSynced = false;
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: enabledConnectorSlugs });
    });
    context.mocks.api(
      userConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledConnectorSlugs: ["google-drive"],
          operation: "add",
        });
        enabledConnectorSlugs = [...body.enabledConnectorSlugs];
        agentAuthorized = true;
        return respond(200, {
          enabledConnectorSlugs,
        });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ body, respond }) => {
        expect(enabledConnectorSlugs).toStrictEqual(["google-drive"]);
        expect(body).toStrictEqual({
          runId: "run-sidebar",
          fileId: "artifact-drive-agent-notes",
        });
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-agent-notes",
            name: "drive-agent-notes.md",
            webViewLink: "https://drive.test/drive-agent-notes",
          },
        };
        artifactSynced = true;
        return respond(200, {
          id: "drive-file-agent-notes",
          name: "drive-agent-notes.md",
          webViewLink: "https://drive.test/drive-agent-notes",
        });
      },
    );

    setupChatThread({ artifactFiles });
    await openCatalogArtifact("drive-agent-notes.md");
    await screen.findByText("The artifact is ready.");

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Connect Google Drive")).toBeEnabled();
    });
    await user.click(menuItemByText("Connect Google Drive"));

    await waitFor(() => {
      expect(agentAuthorized).toBeTruthy();
      expect(artifactSynced).toBeTruthy();
      expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
    });
  });

  it.each([
    {
      intent: "add",
      initialConnector: null,
      catalogStatus: googleDriveCatalogStatus(),
      account: { intent: "add" as const },
    },
    {
      intent: "reconnect",
      initialConnector: googleDriveConnector({
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
      catalogStatus: googleDriveCatalogStatus({
        connected: true,
        connectionStatus: "reconnect-required",
        connection: {
          id: googleDriveConnector().id,
          authMethod: "oauth",
          externalUsername: "drive-user",
          externalEmail: "drive-user@example.com",
          reconnectReason: "authorization_expired_or_revoked",
        },
      }),
      account: {
        intent: "reconnect" as const,
        connectionId: googleDriveConnector().id,
      },
    },
  ])(
    "connects Google Drive from an artifact with explicit $intent intent",
    async ({ initialConnector, catalogStatus, account }) => {
      const user = userEvent.setup({ delay: null });
      const markdownUrl =
        "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-connect-notes.md";
      const summary = catalogArtifact({ title: "drive-connect-notes.md" });
      const artifactFiles = [
        threadArtifactFile(markdownUrl, {
          id: "artifact-drive-connect-notes",
          filename: "drive-connect-notes.md",
          googleDriveSync: { status: "disconnected" },
        }),
      ];

      setupArtifactCatalog(
        [summary],
        new Map([
          [
            summary.id,
            catalogFileDetail({
              contentType: "text/markdown",
              filename: "drive-connect-notes.md",
              fileId: "f0000000-0000-4000-a000-000000000004",
              summary,
              url: markdownUrl,
            }),
          ],
        ]),
      );
      context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
        return respond(200, { connectors: [catalogStatus] });
      });
      context.mocks.http.get(markdownUrl, () => {
        return new Response("# Connect notes\n\nReady for Drive.", {
          headers: { "Content-Type": "text/plain" },
        });
      });

      let connectorConnected = false;
      let agentAuthorized = false;
      let oauthStarted = false;
      let artifactSynced = false;
      context.mocks.api(connectorsMainContract.list, ({ respond }) => {
        return respond(200, {
          connectors: connectorConnected
            ? [
                googleDriveConnector({
                  updatedAt: "2026-01-01T00:00:01Z",
                }),
              ]
            : initialConnector
              ? [initialConnector]
              : [],
          connectorProvidedBindings: [],
        });
      });
      context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, {
          enabledConnectorSlugs: agentAuthorized ? ["google-drive"] : [],
        });
      });
      context.mocks.api(userConnectorsContract.update, ({ never }) => {
        return never();
      });
      const authWindow = context.mocks.browser.authWindow();
      Object.defineProperty(authWindow, "location", {
        value: { href: "" },
        configurable: true,
      });
      context.mocks.browser.open(authWindow);
      context.mocks.api(
        connectorOauthStartContract.start,
        ({ body, params, respond }) => {
          expect(params.connectorSlug).toBe("google-drive");
          expect(body).toStrictEqual({
            account,
            authMethod: "oauth",
            agentId: AGENT_ID,
            authorizeAgent: true,
            callbackTarget: "app",
          });
          oauthStarted = true;
          connectorConnected = true;
          agentAuthorized = true;
          authWindow.close();
          return respond(200, {
            authorizationUrl: "https://accounts.google.test/drive/authorize",
          });
        },
      );
      context.mocks.api(
        chatThreadArtifactsContract.syncGoogleDrive,
        ({ body, respond }) => {
          expect(connectorConnected).toBeTruthy();
          expect(agentAuthorized).toBeTruthy();
          expect(body).toStrictEqual({
            runId: "run-sidebar",
            fileId: "artifact-drive-connect-notes",
          });
          artifactFiles[0] = {
            ...artifactFiles[0]!,
            googleDriveSync: {
              status: "synced",
              id: "drive-file-connect-notes",
              name: "drive-connect-notes.md",
              webViewLink: "https://drive.test/drive-connect-notes",
            },
          };
          artifactSynced = true;
          return respond(200, {
            id: "drive-file-connect-notes",
            name: "drive-connect-notes.md",
            webViewLink: "https://drive.test/drive-connect-notes",
          });
        },
      );

      setupChatThread({ artifactFiles });
      await openCatalogArtifact("drive-connect-notes.md");
      await screen.findByText("Ready for Drive.");

      await user.click(screen.getByLabelText("Download artifact"));
      await waitFor(() => {
        expect(menuItemByText("Connect Google Drive")).toBeEnabled();
      });
      await user.click(menuItemByText("Connect Google Drive"));

      await waitFor(() => {
        expect(oauthStarted).toBeTruthy();
      });
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: "google-drive",
      });

      await waitFor(() => {
        expect(artifactSynced).toBeTruthy();
        expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
      });
    },
  );

  it("reconnects the selected Drive account before syncing the artifact", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-selected-notes.md";
    const summary = catalogArtifact({ title: "drive-selected-notes.md" });
    const artifactFiles = [
      threadArtifactFile(markdownUrl, {
        id: "artifact-drive-selected-notes",
        filename: "drive-selected-notes.md",
        googleDriveSync: {
          status: "disconnected",
          recovery: {
            action: "reconnect",
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
          },
        },
      }),
    ];

    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/markdown",
            filename: "drive-selected-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000005",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.data.connectors([
      googleDriveConnector(),
      googleDriveConnector({
        id: SELECTED_DRIVE_CONNECTION_ID,
        externalId: "selected-drive-external-id",
        externalUsername: "selected-drive-user",
        externalEmail: "selected-drive@example.test",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
    ]);
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [googleDriveCatalogStatus()],
      });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Selected notes\n\nReady for Drive.", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    let accountUpdatedAt = "2026-01-01T00:00:00Z";
    let accountReadCount = 0;
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, query, respond }) => {
        expect(params.connectionId).toBe(SELECTED_DRIVE_CONNECTION_ID);
        expect(query).toStrictEqual({
          kind: "builtin",
          connectorSlug: "google-drive",
        });
        accountReadCount += 1;
        return respond(
          200,
          googleDriveAccountConnection({ updatedAt: accountUpdatedAt }),
        );
      },
    );

    let oauthStarted = false;
    let artifactSynced = false;
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("google-drive");
        expect(body).toStrictEqual({
          account: {
            intent: "reconnect",
            connectionId: SELECTED_DRIVE_CONNECTION_ID,
          },
          authMethod: "oauth",
          agentId: AGENT_ID,
          authorizeAgent: true,
          callbackTarget: "app",
        });
        oauthStarted = true;
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/drive/authorize",
        });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ body, respond }) => {
        expect(accountUpdatedAt).toBe("2026-01-01T00:00:01Z");
        expect(body).toStrictEqual({
          runId: "run-sidebar",
          fileId: "artifact-drive-selected-notes",
        });
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-selected-notes",
            name: "drive-selected-notes.md",
            webViewLink: "https://drive.test/drive-selected-notes",
          },
        };
        artifactSynced = true;
        return respond(200, {
          id: "drive-file-selected-notes",
          name: "drive-selected-notes.md",
          webViewLink: "https://drive.test/drive-selected-notes",
        });
      },
    );

    setupChatThread({ artifactFiles });
    await openCatalogArtifact("drive-selected-notes.md");
    await screen.findByText("Ready for Drive.");

    await user.click(screen.getByLabelText("Download artifact"));
    await user.click(await screen.findByText("Connect Google Drive"));
    await waitFor(() => {
      expect(oauthStarted).toBeTruthy();
    });

    const readsBeforeSiblingEvent = accountReadCount;
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: "google-drive",
    });
    await waitFor(() => {
      expect(accountReadCount).toBeGreaterThan(readsBeforeSiblingEvent);
    });
    expect(artifactSynced).toBeFalsy();

    accountUpdatedAt = "2026-01-01T00:00:01Z";
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: "google-drive",
    });
    await waitFor(() => {
      expect(artifactSynced).toBeTruthy();
      expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
    });
  });

  it("does not mutate a sibling when selected Drive recovery is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-unavailable-notes.md";
    const summary = catalogArtifact({ title: "drive-unavailable-notes.md" });

    setupArtifactCatalog(
      [summary],
      new Map([
        [
          summary.id,
          catalogFileDetail({
            contentType: "text/markdown",
            filename: "drive-unavailable-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000006",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [googleDriveCatalogStatus()],
      });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Unavailable notes\n\nNo safe recovery.", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    setupChatThread({
      artifactFiles: [
        threadArtifactFile(markdownUrl, {
          id: "artifact-drive-unavailable-notes",
          filename: "drive-unavailable-notes.md",
          googleDriveSync: {
            status: "disconnected",
            recovery: { action: "unavailable" },
          },
        }),
      ],
    });
    await openCatalogArtifact("drive-unavailable-notes.md");
    await screen.findByText("No safe recovery.");

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Connect Google Drive")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
  });

  it("shows empty and unavailable CSV states from catalog details", async () => {
    const emptyCsvUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/empty.csv";
    const failedCsvUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/failed-metrics.csv";
    const emptySummary = catalogArtifact({ title: "empty.csv" });
    const failedSummary = catalogArtifact({
      id: "a0000000-0000-4000-a000-000000000002",
      title: "failed-metrics.csv",
    });

    setupArtifactCatalog(
      [emptySummary, failedSummary],
      new Map([
        [
          emptySummary.id,
          catalogFileDetail({
            contentType: "text/csv",
            filename: "empty.csv",
            fileId: "f0000000-0000-4000-a000-000000000002",
            summary: emptySummary,
            url: emptyCsvUrl,
          }),
        ],
        [
          failedSummary.id,
          catalogFileDetail({
            contentType: "text/csv",
            filename: "failed-metrics.csv",
            fileId: "f0000000-0000-4000-a000-000000000003",
            summary: failedSummary,
            url: failedCsvUrl,
          }),
        ],
      ]),
    );
    context.mocks.http.get(emptyCsvUrl, () => {
      return new Response("", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(failedCsvUrl, () => {
      return new Response(null, { status: 503 });
    });
    setupChatThread({
      artifactFiles: [
        threadArtifactFile(emptyCsvUrl, {
          id: "artifact-empty-csv",
          filename: "empty.csv",
          contentType: "text/csv",
        }),
        threadArtifactFile(failedCsvUrl, {
          id: "artifact-failed-csv",
          filename: "failed-metrics.csv",
          contentType: "text/csv",
        }),
      ],
    });

    await openCatalogArtifact("empty.csv");
    await expect(screen.findByText("Empty CSV.")).resolves.toBeInTheDocument();

    click(screen.getByLabelText("Back to all artifacts"));
    await screen.findByTestId("thread-sidebar-artifacts");
    click(await screen.findByLabelText("Preview failed-metrics.csv"));

    await expect(
      screen.findByText("CSV preview unavailable."),
    ).resolves.toBeInTheDocument();
  });

  it("keeps image zoom controls available on catalog details", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/launch-visual.png";
    const summary = catalogArtifact({
      kind: "image",
      title: "launch-visual.png",
    });
    const detail: ArtifactDetail = {
      ...summary,
      kind: "image",
      file: {
        id: "f0000000-0000-4000-a000-000000000004",
        filename: "launch-visual.png",
        contentType: "image/png",
        size: 2048,
        url: imageUrl,
        previewImageUrl: null,
      },
      model: null,
      provider: null,
    };

    setupArtifactCatalog([summary], new Map([[summary.id, detail]]));
    setupChatThread({
      artifactFiles: [
        threadArtifactFile(imageUrl, {
          id: "artifact-launch-visual",
          filename: "launch-visual.png",
          contentType: "image/png",
        }),
      ],
    });

    await openCatalogArtifact("launch-visual.png");
    const zoomLevel = screen.getByTestId("artifact-sidebar-image-zoom-level");
    const zoomOut = screen.getByTestId("artifact-sidebar-image-zoom-out");
    const zoomIn = screen.getByTestId("artifact-sidebar-image-zoom-in");
    const resetZoom = screen.getByTestId("artifact-sidebar-image-reset-zoom");
    expect(zoomLevel).toHaveTextContent("100%");
    expect(zoomOut).not.toHaveAttribute("title");
    expect(zoomIn).not.toHaveAttribute("title");
    expect(resetZoom).not.toHaveAttribute("title");

    const expectControlTooltip = async (button: HTMLElement, label: string) => {
      const trigger =
        button.closest<HTMLElement>('[data-slot="tooltip-trigger"]') ?? button;
      await user.hover(trigger);
      await expect(screen.findByText(label)).resolves.toBeVisible();
      await user.unhover(trigger);
      await waitFor(() => {
        expect(screen.queryByText(label)).not.toBeInTheDocument();
      });
    };

    await expectControlTooltip(zoomOut, "Zoom out");
    await expectControlTooltip(zoomIn, "Zoom in");
    await expectControlTooltip(resetZoom, "Reset zoom");

    await user.click(zoomIn);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(resetZoom);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });
  });

  it("does not auto-open run-group sidebar cards", async () => {
    const completedUrl = "https://completed-deck.sites.vm7.io";
    const runningUrl = "https://running-browser-notes.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });

    setupChatThread({
      messages: [
        {
          id: "msg-completed-user",
          role: "user",
          content: "Build the completed deck",
          runId: "run-completed",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-completed-card",
          role: "assistant",
          content: `[Completed deck](${completedUrl})`,
          runId: "run-completed",
          seqId: 2,
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-completed-finish",
          role: "assistant",
          content: null,
          runId: "run-completed",
          runLifecycleEvent: "completed",
          seqId: 3,
          createdAt: "2026-03-10T00:00:02Z",
        },
        {
          id: "msg-running-user",
          role: "user",
          content: "Continue in the browser",
          runId: "run-running",
          seqId: 4,
          createdAt: "2026-03-10T00:00:03Z",
        },
        {
          id: "msg-running-card",
          role: "assistant",
          content: `[Running notes](${runningUrl})`,
          runId: "run-running",
          seqId: 5,
          createdAt: "2026-03-10T00:00:04Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("attachment-preview-html")).toHaveLength(2);
    });
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("syncs browser fit after the sidebar entry transition", async () => {
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    const browser = browserSession();
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: { ...browser, liveUrl: null } });
    });
    setupChatThread();

    click(await screen.findByLabelText("Open browser"));
    const frame = await screen.findByTitle("Live browser: Thread browser");
    const viewport = frame.closest("[data-browser-session-viewport]");
    if (!(viewport instanceof HTMLDivElement)) {
      throw new Error("Expected a live browser viewport");
    }
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 720, height: 900 }),
    );
    expect(screen.getByLabelText("Fit browser to window")).not.toBeVisible();

    const transitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(transitionEnd, "propertyName", { value: "width" });
    fireEvent(screen.getByTestId("chat-thread-sidebar-pane"), transitionEnd);

    await waitFor(() => {
      expect(screen.getByLabelText("Fit browser to window")).toBeVisible();
    });
  });

  it("auto-opens the thread browser while its latest lifecycle event is open", async () => {
    const liveUrl = "https://live.browser-use.com/?wss=auto-open-browser";
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    let browser = browserSession({
      name: "Auto-open browser",
      liveUrl,
    });
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    let browserRequests = 0;
    context.mocks.api(browserContract.get, async ({ respond }) => {
      browserRequests += 1;
      if (browserRequests === 1) {
        requestStarted.resolve();
        await releaseResponse.promise;
      }
      return respond(200, { browser });
    });
    let leaseRequests = 0;
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      leaseRequests += 1;
      return respond(200, {
        browser: {
          ...browser,
          // The production lease endpoint extends the instance without
          // returning its provider live URL.
          liveUrl: null,
        },
      });
    });
    const resizeAspectRatios: number[] = [];
    context.mocks.api(browserContract.resizeByThread, ({ body, respond }) => {
      resizeAspectRatios.push(body.aspectRatio);
      if (resizeAspectRatios.length === 2) {
        return respond(404, {
          error: {
            code: "BROWSER_NOT_FOUND",
            message: "Managed browser not found",
          },
        });
      }
      browser = {
        ...browser,
        screen: { width: 1440, height: 1800, resizable: true },
        updatedAt: "2026-03-10T00:00:00.500Z",
      };
      return respond(200, { browser });
    });
    setupChatThread({
      messages: [
        {
          id: "c0000000-0000-4000-a000-000000000051",
          eventType: "browser.open",
          content: null,
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    await requestStarted.promise;
    const sidebar = await screen.findByLabelText("Live browser");
    expect(sidebar).toHaveAttribute("data-browser-session-sidebar");
    expect(
      screen.queryByTitle("Live browser: Auto-open browser"),
    ).not.toBeInTheDocument();

    releaseResponse.resolve();
    const frame = await screen.findByTitle("Live browser: Auto-open browser");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame.closest("[data-browser-session-sidebar]")).not.toBeNull();
    expect(resizeAspectRatios).toStrictEqual([]);

    const viewport = frame.closest("[data-browser-session-viewport]");
    if (!(viewport instanceof HTMLDivElement)) {
      throw new Error("Expected a live browser viewport");
    }
    let viewportWidth = 720;
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => {
      return DOMRect.fromRect({ width: viewportWidth, height: 900 });
    });
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize sidebar",
    });
    const sidebarLayout = resizeHandle.parentElement;
    if (!(sidebarLayout instanceof HTMLDivElement)) {
      throw new Error("Expected the sidebar layout");
    }
    vi.spyOn(sidebarLayout, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 1600, height: 900 }),
    );
    fireEvent.pointerDown(resizeHandle, { clientX: 840 });
    const resizeMask = document.querySelector(
      "[data-chat-thread-sidebar-resize-mask]",
    );
    if (!(resizeMask instanceof HTMLDivElement)) {
      throw new Error("Expected the sidebar resize mask");
    }
    fireEvent.pointerMove(resizeMask, { clientX: 780 });
    fireEvent.pointerUp(resizeMask);
    const fitWindow = await waitFor(() => {
      const button = queryAllByRoleFast("button").find((candidate) => {
        return candidate.getAttribute("aria-label") === "Fit browser to window";
      });
      expect(button).toBeDefined();
      expect(button).toBeVisible();
      return button;
    });
    if (!(fitWindow instanceof HTMLButtonElement)) {
      throw new Error("Expected the fit browser button");
    }
    expect(fitWindow).toHaveTextContent("Fit");
    expect(fitWindow.closest("[data-browser-session-viewport]")).toBe(viewport);
    expect(fitWindow).toBeEnabled();
    click(fitWindow);

    await waitFor(() => {
      expect(leaseRequests).toBeGreaterThan(0);
      expect(resizeAspectRatios).toStrictEqual([0.8]);
      expect(screen.getByLabelText("Fit browser to window")).not.toBeVisible();
      expect(
        screen.getByTitle("Live browser: Auto-open browser"),
      ).toHaveAttribute("src", liveUrl);
    });

    viewportWidth = 900;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(screen.getByLabelText("Fit browser to window")).toBeVisible();
    });
    click(screen.getByLabelText("Fit browser to window"));
    await waitFor(() => {
      expect(resizeAspectRatios).toStrictEqual([0.8, 1]);
      expect(screen.getByLabelText("Fit browser to window")).toBeEnabled();
    });
    expect(
      screen.queryByText("Managed browser not found"),
    ).not.toBeInTheDocument();

    viewportWidth = 720;
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(screen.getByLabelText("Fit browser to window")).not.toBeVisible();
    });

    await waitFor(() => {
      expect(hasSubscription("browserSessionChanged")).toBeTruthy();
    });
    browser = {
      ...browser,
      screen: { width: 1440, height: 900, resizable: true },
      updatedAt: "2026-03-10T00:00:01.000Z",
    };
    triggerAblyEvent("browserSessionChanged", { threadId: THREAD_ID });
    await waitFor(() => {
      expect(viewport).toHaveAttribute("data-browser-aspect-ratio", "1.6");
      expect(screen.getByLabelText("Fit browser to window")).toBeVisible();
    });
  });

  it("auto-opens the browser sidebar before the event scroll animation frame", async () => {
    const pendingFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, {
        browser: browserSession({ liveUrl: null }),
      });
    });

    setupChatThread({
      messages: [
        {
          id: "c0000000-0000-4000-a000-000000000058",
          eventType: "browser.open",
          content: null,
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    await expect(
      screen.findByLabelText("Live browser"),
    ).resolves.toHaveAttribute("data-browser-session-sidebar");
    expect(pendingFrames.length).toBeGreaterThan(0);

    for (const callback of pendingFrames.splice(0)) {
      callback(0);
    }
  });

  it("does not auto-open when the latest browser lifecycle event is close", async () => {
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });

    setupChatThread({
      messages: [
        {
          id: "c0000000-0000-4000-a000-000000000052",
          eventType: "browser.open",
          content: null,
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "c0000000-0000-4000-a000-000000000053",
          eventType: "browser.close",
          content: null,
          seqId: 2,
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-browser-stopped",
          role: "assistant",
          content: "Browser was stopped.",
          runId: "run-browser-stopped",
          seqId: 3,
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
    });

    await screen.findByText("Browser was stopped.");
    expect(
      screen.queryByTestId("browser-session-sidebar"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
  });

  it("opens never-created browser cards in the shared inactive state", async () => {
    const completedUrl = "https://openable-fallback.sites.vm7.io";
    const deletedDraftId = "c0000000-0000-4000-a000-000000000061";
    const reconnectDraftId = "c0000000-0000-4000-a000-000000000062";
    const createdAt = "2026-03-10T00:00:00.000Z";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
      const deleted = params.mailDraftId === deletedDraftId;
      if (!deleted && params.mailDraftId !== reconnectDraftId) {
        throw new Error(`Unexpected mail draft: ${params.mailDraftId}`);
      }
      return respond(200, {
        mailDraftId: params.mailDraftId,
        mailDraftUrl: `https://app.vm0.ai/mail/drafts/${params.mailDraftId}`,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: [],
          cc: [],
          bcc: [],
          subject: deleted ? "Deleted draft" : "Reconnect draft",
          body: "",
          accessStatus: deleted ? "ready" : "reconnect",
          status: deleted ? "deleted" : "draft",
          detailAvailable: false,
          gmailDraftId: `gmail-${params.mailDraftId}`,
          gmailThreadId: "gmail-thread-id",
          gmailMessageId: "gmail-message-id",
          references: [],
          attachments: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
    });
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Browser not found" },
      });
    });

    setupChatThread({
      messages: [
        {
          id: "msg-openable-fallback",
          role: "assistant",
          content: `[Openable fallback](${completedUrl})`,
          runId: "run-openable-fallback",
          seqId: 1,
          createdAt,
        },
        {
          id: "msg-openable-fallback-finish",
          role: "assistant",
          content: null,
          runId: "run-openable-fallback",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-03-10T00:00:01.000Z",
        },
        {
          id: "msg-unopenable-cards",
          role: "assistant",
          content: [
            `[Deleted](/mail/drafts/${deletedDraftId})`,
            `[Reconnect](/mail/drafts/${reconnectDraftId})`,
            `[Browser](/browsers/${THREAD_ID})`,
          ].join("\n"),
          runId: "run-unopenable-cards",
          seqId: 3,
          createdAt: "2026-03-10T00:00:02.000Z",
        },
      ],
    });

    const browserCard = await waitFor(() => {
      const card = document.querySelector<HTMLElement>(
        "[data-browser-session-card]",
      );
      expect(card).not.toBeNull();
      return card as HTMLElement;
    });
    expect(browserCard).toHaveAttribute(
      "data-browser-session-status",
      "suspended",
    );
    expect(browserCard).toHaveTextContent("Stopped");
    expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Deleted email: Deleted draft"),
    ).resolves.toHaveAttribute("aria-disabled", "true");
    await expect(
      screen.findByLabelText(
        "Reconnect Gmail to access email: Reconnect draft",
      ),
    ).resolves.toBeInTheDocument();
    click(browserCard);
    const browserSidebar = await screen.findByLabelText("Live browser");
    expect(browserSidebar).toHaveAttribute("data-browser-session-sidebar");
    await expect(
      within(browserSidebar).findByText("Browser not live"),
    ).resolves.toBeInTheDocument();
    await expect(
      within(browserSidebar).findByText("Start browser"),
    ).resolves.toBeInTheDocument();
  });

  it("auto-opens a background-synced browser start before mark-read completes", async () => {
    const markReadStarted = context.mocks.deferred<void>();
    const finishMarkRead = context.mocks.deferred<void>();
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(
      chatThreadMarkReadContract.markRead,
      async ({ respond }) => {
        markReadStarted.resolve();
        await finishMarkRead.promise;
        return respond(200, {
          lastReadAt: "2026-03-10T00:00:05Z",
          unreads: [],
        });
      },
    );
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: browserSession({ liveUrl: null }) });
    });
    const fixture = setupChatThread({
      messages: [],
    });

    await screen.findAllByRole("navigation", { name: "Sidebar" });
    await screen.findByRole("textbox", { name: "Message" });
    fixture.publishMessages([
      {
        id: "c0000000-0000-4000-a000-000000000054",
        eventType: "browser.open",
        content: null,
        seqId: 1,
        createdAt: "2026-03-10T00:00:03Z",
      },
      {
        id: "msg-synced-browser",
        role: "assistant",
        content: "Browser is ready.",
        runId: "run-synced",
        seqId: 2,
        createdAt: "2026-03-10T00:00:04Z",
      },
      {
        id: "msg-synced-finish",
        role: "assistant",
        content: null,
        runId: "run-synced",
        runLifecycleEvent: "completed",
        seqId: 3,
        createdAt: "2026-03-10T00:00:05Z",
      },
    ]);

    await markReadStarted.promise;
    await expect(
      screen.findByTitle("Live browser: Thread browser"),
    ).resolves.toBeInTheDocument();
  });

  it("does not reopen the same browser start after the user closes it", async () => {
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: browserSession({ liveUrl: null }) });
    });
    const fixture = setupChatThread({
      messages: [
        {
          id: "c0000000-0000-4000-a000-000000000055",
          eventType: "browser.open",
          content: null,
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    await screen.findByLabelText("Live browser");
    click(screen.getByLabelText("Close live browser"));
    await waitFor(() => {
      expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
    });
    fixture.publishMessages([
      {
        id: "msg-browser-still-running",
        role: "assistant",
        content: "Browser is still running.",
        runId: "run-close",
        seqId: 2,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ]);

    await screen.findByText("Browser is still running.");
    expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
  });

  it("does not replace a sidebar the user already opened", async () => {
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });
    const fixture = setupChatThread({
      messages: [],
    });
    await openArtifactsFromHeader();
    await screen.findByTestId("thread-sidebar-artifacts");

    fixture.publishMessages([
      {
        id: "c0000000-0000-4000-a000-000000000056",
        eventType: "browser.open",
        content: null,
        seqId: 1,
        createdAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "msg-user-choice-preserved",
        role: "assistant",
        content: "Browser started in the background.",
        runId: "run-user-choice",
        seqId: 2,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ]);

    await screen.findByText("Browser started in the background.");
    expect(screen.getByTestId("thread-sidebar-artifacts")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("does not auto-open when the viewport cannot show split view", async () => {
    context.mocks.browser.matchMedia(() => {
      return false;
    });
    setupChatThread({
      messages: [
        {
          id: "c0000000-0000-4000-a000-000000000057",
          eventType: "browser.open",
          content: null,
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-guarded-browser",
          role: "assistant",
          content: "Browser started.",
          runId: "run-guarded",
          seqId: 2,
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    await screen.findByText("Browser started.");
    expect(screen.queryByLabelText("Live browser")).not.toBeInTheDocument();
  });
});
