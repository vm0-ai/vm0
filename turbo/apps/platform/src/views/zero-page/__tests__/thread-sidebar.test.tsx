import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "../../../signals/chat-page/chat-thread-sidebar-layout.ts";
import {
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000001";

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

function googleDriveConnector(): ConnectorResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "google-drive",
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
  autoOpenEnabled = false,
  messages = [
    {
      id: "msg-sidebar-user",
      threadId: THREAD_ID,
      eventType: "input.prompt",
      content: "Build the launch plan",
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
  autoOpenEnabled?: boolean;
  messages?: MockChatEventInput[];
} = {}) {
  let servedMessages = [...messages];
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, { lastReadAt: null });
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
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
    if (query.beforeSeqId !== undefined) {
      return respond(200, { events: [] });
    }
    const events = normalizeMockChatEvents(
      servedMessages.map((message) => {
        return { ...message, threadId: message.threadId ?? THREAD_ID };
      }),
    );
    const sinceSeqId = query.sinceSeqId;
    if (sinceSeqId !== undefined) {
      return respond(200, {
        events: events.filter((event) => {
          return event.seqId > sinceSeqId;
        }),
        hasHistoryBefore: false,
      });
    }
    return respond(200, {
      events,
      hasHistoryBefore: false,
    });
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, {
      runs: [{ runId: "run-sidebar", files: artifactFiles }],
    });
  });

  detachedSetupPage({
    context,
    path: THREAD_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadSidebarAutoOpen]: autoOpenEnabled,
    },
  });

  return {
    publishMessages(nextMessages: MockChatEventInput[]): void {
      servedMessages = [...servedMessages, ...nextMessages];
      const syncThroughSeqId = nextMessages.at(-1)?.seqId;
      if (syncThroughSeqId === undefined) {
        throw new Error("Published chat messages need a seqId");
      }
      context.mocks.ably.trigger(`chatThreadMessageCreated:${THREAD_ID}`, {
        syncThroughSeqId,
      });
    },
  };
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

  it("connects the agent and syncs a catalog artifact to Google Drive", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-sidebar/drive-agent-notes.md";
    const summary = catalogArtifact({ title: "drive-agent-notes.md" });
    const artifactFiles = [
      threadArtifactFile(markdownUrl, {
        id: "artifact-drive-agent-notes",
        filename: "drive-agent-notes.md",
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
            filename: "drive-agent-notes.md",
            fileId: "f0000000-0000-4000-a000-000000000001",
            summary,
            url: markdownUrl,
          }),
        ],
      ]),
    );
    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [] });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Agent notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });

    let enabledTypes: string[] = [];
    let agentAuthorized = false;
    let artifactSynced = false;
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes });
    });
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledTypes: ["google-drive"],
          operation: "add",
        });
        enabledTypes = [...body.enabledTypes];
        agentAuthorized = true;
        return respond(200, { enabledTypes });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ body, respond }) => {
        expect(enabledTypes).toStrictEqual(["google-drive"]);
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
    expect(zoomLevel).toHaveTextContent("100%");

    await user.click(screen.getByTestId("artifact-sidebar-image-zoom-in"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(screen.getByTestId("artifact-sidebar-image-reset-zoom"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });
  });

  it("auto-opens the latest sidebar card from a running run before a completed fallback", async () => {
    const completedUrl = "https://completed-deck.sites.vm7.io";
    const runningUrl = "https://running-browser-notes.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });

    setupChatThread({
      autoOpenEnabled: true,
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
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        runningUrl,
      );
    });
  });

  it("auto-opens a browser card from a running run", async () => {
    const browserId = "c0000000-0000-4000-a000-000000000051";
    const liveUrl = "https://live.browser-use.com/?wss=auto-open-browser";
    const browser: ZeroBrowserSession = {
      id: browserId,
      name: "Auto-open browser",
      status: "active",
      viewerUrl: `https://app.vm0.ai/browsers/${browserId}`,
      liveUrl,
      proxyCountryCode: null,
      timeoutMinutes: 240,
      maxCredits: 500,
      grossCredits: 0,
      creditsCharged: 0,
      idleExpiresAt: "2026-03-10T00:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
    };
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(200, { browser });
    });
    context.mocks.api(zeroBrowserContract.leaseById, ({ respond }) => {
      return respond(200, { browser });
    });
    setupChatThread({
      autoOpenEnabled: true,
      messages: [
        {
          id: "msg-running-browser",
          role: "assistant",
          content: `[Open browser](/browsers/${browserId})`,
          runId: "run-browser",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    const frame = await screen.findByTitle("Live browser: Auto-open browser");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame.closest("[data-browser-session-sidebar]")).not.toBeNull();
  });

  it("falls back to the latest successful run and ignores failed and cancelled runs", async () => {
    const completedUrl = "https://successful-deck.sites.vm7.io";
    const failedUrl = "https://failed-deck.sites.vm7.io";
    const cancelledUrl = "https://cancelled-deck.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });

    setupChatThread({
      autoOpenEnabled: true,
      messages: [
        {
          id: "msg-success-card",
          role: "assistant",
          content: `[Successful deck](${completedUrl})`,
          runId: "run-success",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-success-finish",
          role: "assistant",
          content: null,
          runId: "run-success",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-failed-card",
          role: "assistant",
          content: `[Failed deck](${failedUrl})`,
          runId: "run-failed",
          seqId: 3,
          createdAt: "2026-03-10T00:00:02Z",
        },
        {
          id: "msg-failed-finish",
          role: "assistant",
          content: null,
          error: "Presentation generation failed",
          runId: "run-failed",
          runLifecycleEvent: "failed",
          seqId: 4,
          createdAt: "2026-03-10T00:00:03Z",
        },
        {
          id: "msg-cancelled-card",
          role: "assistant",
          content: `[Cancelled deck](${cancelledUrl})`,
          runId: "run-cancelled",
          seqId: 5,
          createdAt: "2026-03-10T00:00:04Z",
        },
        {
          id: "msg-cancelled-finish",
          role: "assistant",
          content: null,
          runId: "run-cancelled",
          runLifecycleEvent: "cancelled",
          seqId: 6,
          createdAt: "2026-03-10T00:00:05Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        completedUrl,
      );
    });
  });

  it("skips deleted, reconnect-required, and unavailable cards before falling back", async () => {
    const completedUrl = "https://openable-fallback.sites.vm7.io";
    const deletedDraftId = "c0000000-0000-4000-a000-000000000061";
    const reconnectDraftId = "c0000000-0000-4000-a000-000000000062";
    const unavailableBrowserId = "c0000000-0000-4000-a000-000000000063";
    const createdAt = "2026-03-10T00:00:00.000Z";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(zeroMailContract.getDraft, ({ params, respond }) => {
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
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Browser not found" },
      });
    });

    setupChatThread({
      autoOpenEnabled: true,
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
            `[Unavailable browser](/browsers/${unavailableBrowserId})`,
          ].join("\n"),
          runId: "run-unopenable-cards",
          seqId: 3,
          createdAt: "2026-03-10T00:00:02.000Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        completedUrl,
      );
    });
    await expect(
      screen.findByLabelText("Deleted email: Deleted draft"),
    ).resolves.toHaveAttribute("aria-disabled", "true");
    await expect(
      screen.findByLabelText(
        "Reconnect Gmail to access email: Reconnect draft",
      ),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("Browser unavailable"),
    ).resolves.toBeInTheDocument();
  });

  it("auto-opens a sidebar card received from background sync", async () => {
    const syncedUrl = "https://synced-presentation.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    const fixture = setupChatThread({
      autoOpenEnabled: true,
    });

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    fixture.publishMessages([
      {
        id: "msg-synced-user",
        role: "user",
        content: "Build a presentation",
        runId: "run-synced",
        seqId: 3,
        createdAt: "2026-03-10T00:00:03Z",
      },
      {
        id: "msg-synced-card",
        role: "assistant",
        content: `[Synced presentation](${syncedUrl})`,
        runId: "run-synced",
        seqId: 4,
        createdAt: "2026-03-10T00:00:04Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        syncedUrl,
      );
    });
  });

  it("does not reopen the same auto-opened card after the user closes it", async () => {
    const cardUrl = "https://closed-presentation.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    const fixture = setupChatThread({
      autoOpenEnabled: true,
      messages: [
        {
          id: "msg-card-before-close",
          role: "assistant",
          content: `[Presentation](${cardUrl})`,
          runId: "run-close",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    await screen.findByTestId("artifact-sidebar");
    click(screen.getByLabelText("Close artifact"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    fixture.publishMessages([
      {
        id: "msg-same-card-after-close",
        role: "assistant",
        content: `[Presentation again](${cardUrl})`,
        runId: "run-close",
        seqId: 2,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getAllByTestId("attachment-preview-html")).toHaveLength(2);
    });
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("does not replace a sidebar the user already opened", async () => {
    const syncedUrl = "https://user-choice-preserved.sites.vm7.io";
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
      autoOpenEnabled: true,
      messages: [],
    });
    await openArtifactsFromHeader();
    await screen.findByTestId("thread-sidebar-artifacts");

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    fixture.publishMessages([
      {
        id: "msg-user-choice-card",
        role: "assistant",
        content: `[New presentation](${syncedUrl})`,
        runId: "run-user-choice",
        seqId: 1,
        createdAt: "2026-03-10T00:00:00Z",
      },
    ]);

    await screen.findByTestId("attachment-preview-html");
    expect(screen.getByTestId("thread-sidebar-artifacts")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "the auto-open switch is off",
      autoOpenEnabled: false,
      splitViewAvailable: true,
    },
    {
      name: "the viewport cannot show split view",
      autoOpenEnabled: true,
      splitViewAvailable: false,
    },
  ])("does not auto-open when $name", async (scenario) => {
    const cardUrl = "https://guarded-deck.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return (
        scenario.splitViewAvailable &&
        query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY
      );
    });
    setupChatThread({
      autoOpenEnabled: scenario.autoOpenEnabled,
      messages: [
        {
          id: "msg-guarded-card",
          role: "assistant",
          content: `[Guarded deck](${cardUrl})`,
          runId: "run-guarded",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-guarded-finish",
          role: "assistant",
          content: null,
          runId: "run-guarded",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    await screen.findByTestId("attachment-preview-html");
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
});
