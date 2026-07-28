import { screen, waitFor } from "@testing-library/react";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
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

function setupChatThread({
  newSidebarEnabled,
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
  newSidebarEnabled: boolean;
  autoOpenEnabled?: boolean;
  messages?: MockChatEventInput[];
}) {
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

  detachedSetupPage({
    context,
    path: THREAD_PATH,
    featureSwitches: {
      [FeatureSwitchKey.NewChatThreadSidebar]: newSidebarEnabled,
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

describe("thread-owned utility sidebar", () => {
  it("opens the thread-scoped catalog list without legacy search params", async () => {
    const requestedThreadIds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedThreadIds.push(query.chatThreadId);
      return respond(200, {
        artifacts: [catalogArtifact()],
        nextCursor: null,
      });
    });

    setupChatThread({ newSidebarEnabled: true });
    await openArtifactsFromHeader();

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });
    await screen.findByLabelText("Preview launch-plan.txt");
    expect(requestedThreadIds).toContain(THREAD_ID);
    // The legacy search-param inbox stays closed on the new track.
    expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
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

    setupChatThread({ newSidebarEnabled: true });
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

  it("keeps the legacy artifact inbox when the switch is off", async () => {
    setupChatThread({ newSidebarEnabled: false, messages: [] });
    await openArtifactsFromHeader();

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("thread-sidebar-artifacts"),
    ).not.toBeInTheDocument();
  });

  it("auto-opens the latest sidebar card from a running run before a completed fallback", async () => {
    const completedUrl = "https://completed-deck.sites.vm7.io";
    const runningUrl = "https://running-browser-notes.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });

    setupChatThread({
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
      newSidebarEnabled: true,
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
