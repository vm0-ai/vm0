import { screen, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { navigateToChat$ } from "../../../signals/okou-page/nav.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

type PostHogCapture = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;
type PostHogIdentify = (
  distinctId: string,
  properties?: Record<string, unknown>,
) => void;
type PostHogInit = (key: string, options?: Record<string, unknown>) => void;
type PostHogRegister = (properties: Record<string, unknown>) => void;
type PostHogReset = () => void;
type PostHogUnregister = (property: string) => void;

const { apiOriginMarker, posthog } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_chat_thread_metadata_readiness_test");
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return {
    apiOriginMarker,
    posthog: {
      capture: vi.fn<PostHogCapture>(),
      identify: vi.fn<PostHogIdentify>(),
      init: vi.fn<PostHogInit>(),
      register: vi.fn<PostHogRegister>(),
      reset: vi.fn<PostHogReset>(),
      unregister: vi.fn<PostHogUnregister>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const FIRST_EVENT_ID = "d0000000-0000-4000-a000-000000000001";
const SECOND_EVENT_ID = "d0000000-0000-4000-a000-000000000002";
const THIRD_EVENT_ID = "d0000000-0000-4000-a000-000000000003";

beforeEach(() => {
  posthog.capture.mockReset();
});

afterAll(() => {
  apiOriginMarker.remove();
});

function prepareAgent(): void {
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
}

function setupChatPage(path = `/chats/${THREAD_ID}`): void {
  prepareAgent();
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  detachedSetupPage({ context, path });
}

function shellMetadata(threadId: string, title: string): ChatThreadMetadata {
  return {
    id: threadId,
    agentId: AGENT_ID,
    title,
    pinnedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function snapshotThread(
  threadId: string,
  title: string,
): ChatThreadSnapshotProjection {
  return {
    id: threadId,
    agentId: AGENT_ID,
    title,
    sortAt: "2026-08-26T00:00:02.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:02.000Z",
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function threadEvent(args: {
  readonly eventId: string;
  readonly seqId: number;
  readonly kind: "created" | "renamed";
  readonly threadId: string;
  readonly title: string;
}): ChatThreadEvent {
  return {
    id: args.eventId,
    seqId: args.seqId,
    kind: args.kind,
    chatThreadId: args.threadId,
    agentId: AGENT_ID,
    title: args.title,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
    createdAt: `2026-08-26T00:00:0${args.seqId}.000Z`,
  };
}

async function expectActiveThread(
  threadId: string,
  title: string,
): Promise<void> {
  await waitFor(() => {
    expect(
      document.querySelector(`[data-chat-thread-container-id="${threadId}"]`),
    ).not.toBeNull();
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      title,
    );
  });
}

describe("chat thread metadata readiness", () => {
  it("uses in-memory event metadata without another metadata request", async () => {
    const metadataThreadIds: string[] = [];
    context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
      metadataThreadIds.push(params.id);
      return respond(200, shellMetadata(params.id, "Bootstrap title"));
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [
          snapshotThread(THREAD_ID, "Canonical first thread"),
          snapshotThread(OTHER_THREAD_ID, "Canonical memory hit"),
        ],
        latestEventId: FIRST_EVENT_ID,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    setupChatPage();
    await expectActiveThread(THREAD_ID, "Canonical first thread");
    const metadataRequestCount = metadataThreadIds.length;

    context.store.set(navigateToChat$, OTHER_THREAD_ID);

    await expectActiveThread(OTHER_THREAD_ID, "Canonical memory hit");
    expect(metadataThreadIds).toHaveLength(metadataRequestCount);
  });

  it("shows the real shell on an IndexedDB miss while cold sync continues", async () => {
    const metadataRequested = context.mocks.deferred<void>();
    const snapshotRequested = context.mocks.deferred<void>();
    const releaseSnapshot = context.mocks.deferred<void>();
    context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
      metadataRequested.resolve();
      return respond(200, shellMetadata(THREAD_ID, "Fast shell title"));
    });
    context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
      snapshotRequested.resolve();
      await releaseSnapshot.promise;
      return respond(200, {
        chatThreads: [snapshotThread(THREAD_ID, "Canonical title")],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    setupChatPage();
    await Promise.all([metadataRequested.promise, snapshotRequested.promise]);

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Fast shell title",
    );
    expect(releaseSnapshot.settled()).toBeFalsy();

    releaseSnapshot.resolve();

    await waitFor(() => {
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Canonical title",
      );
    });
  });

  it("keeps paginating canonically after a fast metadata hit", async () => {
    const releaseLastPage = context.mocks.deferred<void>();
    const lastPageRequested = context.mocks.deferred<void>();
    const intermediateRename = threadEvent({
      eventId: SECOND_EVENT_ID,
      seqId: 2,
      kind: "renamed",
      threadId: THREAD_ID,
      title: "Intermediate title",
    });
    const finalRename = threadEvent({
      eventId: THIRD_EVENT_ID,
      seqId: 3,
      kind: "renamed",
      threadId: THREAD_ID,
      title: "Final canonical title",
    });
    context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
      return respond(200, shellMetadata(THREAD_ID, "Fast paged shell"));
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread(THREAD_ID, "Snapshot title")],
        latestEventId: FIRST_EVENT_ID,
        latestSeqId: 1,
      });
    });
    context.mocks.api(
      chatThreadsContract.events,
      async ({ query, respond }) => {
        if (query.sinceSeqId === 1) {
          return respond(200, {
            events: [intermediateRename],
            hasMore: true,
          });
        }
        if (query.sinceSeqId === 2) {
          lastPageRequested.resolve();
          await releaseLastPage.promise;
          return respond(200, { events: [finalRename], hasMore: false });
        }
        return respond(200, { events: [], hasMore: false });
      },
    );

    setupChatPage();
    await lastPageRequested.promise;

    await expectActiveThread(THREAD_ID, "Fast paged shell");
    expect(releaseLastPage.settled()).toBeFalsy();

    releaseLastPage.resolve();

    await waitFor(() => {
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Final canonical title",
      );
    });
  });

  it("preserves a multi-tab event barrier before resolving a new route", async () => {
    const catchUpRequested = context.mocks.deferred<void>();
    const releaseCatchUp = context.mocks.deferred<void>();
    const metadataThreadIds: string[] = [];
    let catchUp = false;
    const created = threadEvent({
      eventId: SECOND_EVENT_ID,
      seqId: 2,
      kind: "created",
      threadId: THREAD_ID,
      title: "Created in another tab",
    });
    context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
      metadataThreadIds.push(params.id);
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread(OTHER_THREAD_ID, "Existing thread")],
        latestEventId: FIRST_EVENT_ID,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, async ({ respond }) => {
      if (!catchUp) {
        return respond(200, { events: [], hasMore: false });
      }
      catchUpRequested.resolve();
      await releaseCatchUp.promise;
      return respond(200, { events: [created], hasMore: false });
    });

    setupChatPage(`/chats/${OTHER_THREAD_ID}`);
    await expectActiveThread(OTHER_THREAD_ID, "Existing thread");
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
    });

    catchUp = true;
    context.mocks.ably.trigger("threadListChanged");
    await catchUpRequested.promise;
    context.store.set(navigateToChat$, THREAD_ID);

    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
      ),
    ).not.toBeNull();
    expect(metadataThreadIds).not.toContain(THREAD_ID);
    expect(
      screen.queryByRole("heading", { name: "Chat thread not found" }),
    ).not.toBeInTheDocument();

    releaseCatchUp.resolve();

    await expectActiveThread(THREAD_ID, "Created in another tab");
    expect(metadataThreadIds).not.toContain(THREAD_ID);
  });

  it("preserves foreground synchronization across realtime reconnect", async () => {
    const reconnectRequested = context.mocks.deferred<void>();
    const releaseReconnect = context.mocks.deferred<void>();
    const metadataThreadIds: string[] = [];
    let reconnecting = false;
    const created = threadEvent({
      eventId: SECOND_EVENT_ID,
      seqId: 2,
      kind: "created",
      threadId: THREAD_ID,
      title: "Recovered after reconnect",
    });
    context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
      metadataThreadIds.push(params.id);
      return respond(200, shellMetadata(params.id, "Narrow response"));
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread(OTHER_THREAD_ID, "Online thread")],
        latestEventId: FIRST_EVENT_ID,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, async ({ respond }) => {
      if (!reconnecting) {
        return respond(200, { events: [], hasMore: false });
      }
      reconnectRequested.resolve();
      await releaseReconnect.promise;
      return respond(200, { events: [created], hasMore: false });
    });

    setupChatPage(`/chats/${OTHER_THREAD_ID}`);
    await expectActiveThread(OTHER_THREAD_ID, "Online thread");
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
    });

    reconnecting = true;
    context.mocks.ably.triggerReconnect();
    await reconnectRequested.promise;
    context.store.set(navigateToChat$, THREAD_ID);

    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
      ),
    ).not.toBeNull();
    expect(metadataThreadIds).not.toContain(THREAD_ID);

    releaseReconnect.resolve();

    await expectActiveThread(THREAD_ID, "Recovered after reconnect");
    expect(metadataThreadIds).not.toContain(THREAD_ID);
  });

  it("reveals the left split pane while right metadata is still loading", async () => {
    const rightMetadataRequested = context.mocks.deferred<void>();
    const releaseRightMetadata = context.mocks.deferred<void>();
    context.mocks.api(
      chatThreadMetadataContract.get,
      async ({ params, respond }) => {
        if (params.id === OTHER_THREAD_ID) {
          rightMetadataRequested.resolve();
          await releaseRightMetadata.promise;
        }
        return respond(
          200,
          shellMetadata(
            params.id,
            params.id === THREAD_ID ? "Ready left pane" : "Ready right pane",
          ),
        );
      },
    );
    context.mocks.api(chatThreadsContract.snapshot, ({ never }) => {
      return never();
    });

    setupChatPage(`/chats/${THREAD_ID}?sidebar=${OTHER_THREAD_ID}`);
    await rightMetadataRequested.promise;

    await waitFor(() => {
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${THREAD_ID}"]`,
        ),
      ).not.toBeNull();
    });
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
      ),
    ).toBeNull();
    expect(releaseRightMetadata.settled()).toBeFalsy();

    releaseRightMetadata.resolve();

    await waitFor(() => {
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
        ),
      ).not.toBeNull();
      expect(screen.getAllByLabelText("Chat thread")).toHaveLength(2);
    });
  });

  it("aborts stale metadata work when navigation changes", async () => {
    const firstMetadataRequested = context.mocks.deferred<void>();
    const firstMetadataAborted = context.mocks.deferred<void>();
    const releaseFirstMetadata = context.mocks.deferred<void>();
    context.mocks.api(
      chatThreadMetadataContract.get,
      async ({ params, request, respond }) => {
        if (params.id === THREAD_ID) {
          firstMetadataRequested.resolve();
          request.signal.addEventListener(
            "abort",
            () => {
              firstMetadataAborted.resolve();
              releaseFirstMetadata.resolve();
            },
            { once: true },
          );
          await releaseFirstMetadata.promise;
          return respond(200, shellMetadata(THREAD_ID, "Stale route"));
        }
        return respond(200, shellMetadata(OTHER_THREAD_ID, "Current route"));
      },
    );
    context.mocks.api(chatThreadsContract.snapshot, ({ never }) => {
      return never();
    });

    setupChatPage();
    await firstMetadataRequested.promise;

    context.store.set(navigateToChat$, OTHER_THREAD_ID);

    await firstMetadataAborted.promise;
    await expectActiveThread(OTHER_THREAD_ID, "Current route");
    expect(
      document.querySelector(`[data-chat-thread-container-id="${THREAD_ID}"]`),
    ).toBeNull();
    expect(screen.queryByText("Stale route")).not.toBeInTheDocument();
  });

  it("does not retain metadata when navigation aborts after cold resolution", async () => {
    const firstMetadataRequested = context.mocks.deferred<void>();
    const releaseFirstMetadata = context.mocks.deferred<void>();
    const secondMetadataRequested = context.mocks.deferred<void>();
    let firstThreadRequestCount = 0;
    context.mocks.api(
      chatThreadMetadataContract.get,
      async ({ params, respond }) => {
        if (params.id === THREAD_ID) {
          firstThreadRequestCount += 1;
          if (firstThreadRequestCount === 1) {
            firstMetadataRequested.resolve();
            await releaseFirstMetadata.promise;
            return respond(
              200,
              shellMetadata(THREAD_ID, "Stale resolved route"),
            );
          }
          secondMetadataRequested.resolve();
          return respond(404, {
            error: {
              code: "CHAT_THREAD_NOT_FOUND",
              message: "Chat thread not found",
            },
          });
        }
        return respond(200, shellMetadata(OTHER_THREAD_ID, "Current route"));
      },
    );
    context.mocks.api(chatThreadsContract.snapshot, ({ never }) => {
      return never();
    });

    setupChatPage();
    await firstMetadataRequested.promise;
    const agentsLink = await waitFor(() => {
      const link = document.querySelector('a[href="/agents"]');
      expect(link).not.toBeNull();
      return link as HTMLElement;
    });
    let navigated = false;
    posthog.capture.mockImplementation((eventName, properties) => {
      if (
        !navigated &&
        eventName === "chat_thread_metadata_shortcut" &&
        properties?.outcome === "hit"
      ) {
        navigated = true;
        agentsLink.click();
      }
    });

    releaseFirstMetadata.resolve();

    await waitFor(() => {
      expect(navigated).toBeTruthy();
      expect(document.title).toBe("Agents | VM0");
    });
    expect(screen.queryByText("Stale resolved route")).not.toBeInTheDocument();

    window.history.back();

    await secondMetadataRequested.promise;
    expect(firstThreadRequestCount).toBe(2);
    expect(screen.queryByText("Stale resolved route")).not.toBeInTheDocument();
  });
});
