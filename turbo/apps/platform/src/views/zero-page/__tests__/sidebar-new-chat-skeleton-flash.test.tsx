/**
 * Reproduces the chat-thread skeleton flash on optimistic create:
 * after clicking the sidebar's "+ New chat" button, the chat pane briefly
 * shows `<div data-chat-skeleton>` before the messages stream renders.
 *
 * Suspected path: when `routeOptimisticChatThread$` awaits `settleResult`
 * (the create POST), settle resolves before `loadRoute$` advances
 * `currentChatThreadId$` to the new id; the line-152 check
 * `currentChatThreadId !== pending.threadId` then clears the optimistic.
 * `setupPaneThread$` sees `matchingOptimistic = null`, so the
 * non-IDB branch unconditionally calls `thread.showSkeleton$` on a fresh
 * remote thread and switches the pane to it — the skeleton is visible
 * until `groupedChatMessages$` settles.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

describe("sidebar new-chat skeleton flash", () => {
  it("does not flash the chat-thread skeleton while creating an optimistic thread", async () => {
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          pinned: [],
          threads: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        });
      }),
      mockApi(chatThreadsContract.create, ({ body, respond }) => {
        return respond(201, {
          id: body.clientThreadId ?? "fallback",
          title: null,
          createdAt: "2026-05-05T00:00:00Z",
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-05-05T00:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
      }),
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(
        within(getSidebar()).getByLabelText(/^New chat with /i),
      ).toBeInTheDocument();
    });

    // Watch the entire document for any `[data-chat-skeleton]` element from
    // the moment we click "+ New chat" until the chat pane settles. The
    // observer fires on every DOM mutation; we also synchronously poll the
    // DOM after each microtask to catch renders that commit and unmount
    // within the same task.
    const skeletonSeen: { mutation: number; microtask: number } = {
      mutation: 0,
      microtask: 0,
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-chat-skeleton]") !== null) {
        skeletonSeen.mutation += 1;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    click(within(getSidebar()).getByLabelText(/^New chat with /i));

    // Drive microtasks while the optimistic flow runs (register → URL push →
    // route load → setupPaneThread$ → settleResult → resolvePaneThread$).
    // Capture skeleton presence at every microtask boundary.
    for (let i = 0; i < 80; i++) {
      if (document.querySelector("[data-chat-skeleton]") !== null) {
        skeletonSeen.microtask += 1;
      }
      await Promise.resolve();
    }

    // Wait for the URL to land on /chats/<newId> and the chat-thread pane to
    // render its empty state, so we know the flow has fully settled.
    let newThreadId = "";
    await waitFor(() => {
      const m = pathname().match(/^\/chats\/([^/?#]+)$/);
      expect(m).not.toBeNull();
      newThreadId = m![1];
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${newThreadId}"]`,
        ),
      ).not.toBeNull();
    });

    // One last poll once everything has settled.
    if (document.querySelector("[data-chat-skeleton]") !== null) {
      skeletonSeen.microtask += 1;
    }
    observer.disconnect();

    expect(skeletonSeen).toStrictEqual({ mutation: 0, microtask: 0 });
  });
});
