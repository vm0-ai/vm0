import { screen, waitFor } from "@testing-library/react";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { currentLeftThread$ } from "../../../signals/chat-page/chat-thread-panes.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "../../../signals/chat-page/chat-thread-sidebar-layout.ts";
import { normalizeMockChatEvents } from "./chat-event-test-helpers.ts";

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
      role: "user",
      content: "Build the launch plan",
      runId: "run-sidebar",
      seqId: 1,
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-sidebar-completed",
      role: "assistant",
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
  messages?: PagedChatMessage[];
}) {
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
    if (
      query.sinceSeqId ||
      query.beforeSeqId ||
      query.sinceId ||
      query.beforeId
    ) {
      return respond(200, { events: [] });
    }
    return respond(200, {
      events: normalizeMockChatEvents(messages),
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
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
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

    const thread = await waitFor(() => {
      const current = context.store.get(currentLeftThread$);
      expect(current).not.toBeNull();
      return current;
    });
    if (!thread) {
      throw new Error("Expected the current chat thread");
    }
    await waitFor(() => {
      expect(context.store.get(thread.sidebar.target$)).toStrictEqual({
        type: "browser",
        browserSessionId: browserId,
      });
    });
  });

  it("falls back to the latest successful run and ignores a newer failed run", async () => {
    const completedUrl = "https://successful-deck.sites.vm7.io";
    const failedUrl = "https://failed-deck.sites.vm7.io";
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
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        completedUrl,
      );
    });
  });

  it("auto-opens a sidebar card received from background sync", async () => {
    const syncedUrl = "https://synced-presentation.sites.vm7.io";
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    setupChatThread({
      newSidebarEnabled: true,
      autoOpenEnabled: true,
    });

    const thread = await waitFor(() => {
      const current = context.store.get(currentLeftThread$);
      expect(current).not.toBeNull();
      return current;
    });
    if (!thread) {
      throw new Error("Expected the current chat thread");
    }
    const events: ChatEvent[] = [
      {
        id: "msg-synced-user",
        threadId: THREAD_ID,
        eventType: "input.prompt",
        content: "Build a presentation",
        runId: "run-synced",
        seqId: 3,
        createdAt: "2026-03-10T00:00:03Z",
      },
      {
        id: "msg-synced-card",
        threadId: THREAD_ID,
        eventType: "output.message",
        content: `[Synced presentation](${syncedUrl})`,
        runId: "run-synced",
        seqId: 4,
        createdAt: "2026-03-10T00:00:04Z",
      },
    ];
    await context.store.set(
      thread.receiveSyncedEvents$,
      events,
      context.signal,
    );

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        syncedUrl,
      );
    });
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
    setupChatThread({
      newSidebarEnabled: true,
      autoOpenEnabled: true,
      messages: [],
    });
    await openArtifactsFromHeader();
    await screen.findByTestId("thread-sidebar-artifacts");

    const thread = await waitFor(() => {
      const current = context.store.get(currentLeftThread$);
      expect(current).not.toBeNull();
      return current;
    });
    if (!thread) {
      throw new Error("Expected the current chat thread");
    }
    await context.store.set(
      thread.receiveSyncedEvents$,
      [
        {
          id: "msg-user-choice-card",
          threadId: THREAD_ID,
          eventType: "output.message",
          content: `[New presentation](${syncedUrl})`,
          runId: "run-user-choice",
          seqId: 1,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
      context.signal,
    );

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
