/**
 * Reproduces the sidebar flicker on creating a new chat thread:
 *   appears (optimistic) → disappears → appears (persisted)
 *
 * Root cause: `<ChatThreads>` renders the optimistic list and the persisted
 * list as two adjacent fragments using `key={session.id}`. When `chatThreads$`
 * resolves with the new thread BEFORE `pendingOptimisticChatThreads$` has
 * recomputed and filtered the entry out, both fragments emit the same key —
 * React drops one, then on the next render the survivor moves between
 * fragments, causing an unmount + remount.
 *
 * Drives the flow exclusively through user-visible DOM (clicking the
 * sidebar's "+ New chat" button); reads the optimistic thread id back out of
 * the rendered `data-chat-thread-id` attribute. Holds the persisted-list
 * refetch with a deferred so the test can deterministically interleave the
 * chat-threads response with the optimistic-list recomputation, then records
 * the sidebar across every microtask between the Ably trigger and the final
 * settle.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type ChatThreadListItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

function countNewThreadRows(sidebar: HTMLElement, threadId: string): number {
  return sidebar.querySelectorAll(`[data-chat-thread-id="${threadId}"]`).length;
}

describe("sidebar new-chat flicker", () => {
  it("renders the new chat row continuously across the optimistic→persisted handoff", async () => {
    // The first chatThreads$ list call resolves immediately so the page can
    // render. Subsequent calls (Ably-triggered reload) are held by the
    // deferred so the test can deliberately interleave its resolution.
    let listResponseThreads: ChatThreadListItem[] = [];
    let listCallCount = 0;
    let holdNextListCalls = false;
    const reloadDeferred = createDeferredPromise<void>(context.signal);
    // Hold the create POST so the optimistic entry stays registered for the
    // duration of the test. Without this, settleResult resolves before the
    // route's loadRoute$ promotes `currentChatThreadId$`, and
    // `routeOptimisticChatThread$` clears the optimistic immediately — which
    // is itself the "disappear" half of the user-visible flicker.
    const createDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(chatThreadsContract.list, async ({ respond }) => {
        listCallCount += 1;
        if (holdNextListCalls) {
          await reloadDeferred.promise;
        }
        return respond(200, splitChatThreadListResponse(listResponseThreads));
      }),
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        await createDeferred.promise;
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

    // Wait until the initial chatThreads$ list call has resolved and the
    // sidebar's "+ New chat" button is mounted.
    await waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(1);
      expect(
        within(getSidebar()).getByLabelText(/^New chat with /i),
      ).toBeInTheDocument();
    });

    // Drive the optimistic-create flow through the actual sidebar button.
    const newChatBtn = within(getSidebar()).getByLabelText(/^New chat with /i);
    await act(() => {
      click(newChatBtn);
    });

    // Read the optimistic thread id back out of the DOM. The id is the
    // crypto.randomUUID() that `createNewChatThread$` minted client-side and
    // wrote into `data-chat-thread-id` on the rendered row.
    let newThreadId = "";
    await waitFor(() => {
      const rows = getSidebar().querySelectorAll<HTMLElement>(
        "[data-chat-thread-id]",
      );
      expect(rows.length).toBeGreaterThan(0);
      const id = rows[0].dataset.chatThreadId ?? null;
      expect(id).toBeTruthy();
      newThreadId = id ?? "";
    });

    // Snapshot the row count on every sidebar DOM mutation throughout the
    // optimistic→persisted handoff. The row should remain present (count >= 1)
    // and never appear duplicated (count <= 1). Combine MutationObserver
    // (catches React-driven DOM commits) with a tight microtask poll
    // (catches synchronous re-renders that occur within the same task).
    const sidebar = getSidebar();
    const snapshots: number[] = [countNewThreadRows(sidebar, newThreadId)];
    const observer = new MutationObserver(() => {
      snapshots.push(countNewThreadRows(sidebar, newThreadId));
    });
    observer.observe(sidebar, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    // Server now "knows about" the new thread and publishes threadListChanged.
    holdNextListCalls = true;
    listResponseThreads = [
      {
        id: newThreadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-05-05T00:00:00Z",
        updatedAt: "2026-05-05T00:00:00Z",
        isRead: true,
        running: false,
      },
    ];

    await act(() => {
      triggerAblyEvent("threadListChanged");
    });

    // Release the persisted-list refetch — chatThreads$ resolves, then
    // pendingOptimisticChatThreads$ recomputes. This is the window where
    // the bug is observable.
    await act(async () => {
      reloadDeferred.resolve();
      // Poll the DOM at every microtask boundary so we catch the synchronous
      // React re-renders that happen as `useSyncExternalStore` subscribers
      // fire one after the other (chatThreads$ first, then pendingOptimistic).
      for (let i = 0; i < 50; i++) {
        snapshots.push(countNewThreadRows(sidebar, newThreadId));
        await Promise.resolve();
      }
    });

    await waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2);
      expect(countNewThreadRows(sidebar, newThreadId)).toBe(1);
    });
    snapshots.push(countNewThreadRows(sidebar, newThreadId));
    observer.disconnect();
    // Let the still-suspended create POST settle so signal teardown can
    // unwind cleanly.
    createDeferred.resolve();

    const dropped = snapshots.filter((c) => {
      return c === 0;
    }).length;
    const collided = snapshots.filter((c) => {
      return c > 1;
    }).length;
    expect({ snapshots, dropped, collided }).toMatchObject({
      dropped: 0,
      collided: 0,
    });
  });
});
