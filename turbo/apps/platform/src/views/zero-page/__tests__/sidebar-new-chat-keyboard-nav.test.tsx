/**
 * Reproduces the keyboard-navigation regression on optimistic threads:
 * after creating a new chat via the sidebar's "+ New chat" button, the new
 * thread is the active page but `mod+shift+ArrowDown` (and ArrowUp) do not
 * move to the adjacent persisted thread until the server's
 * `threadListChanged` reload pulls the newly-created thread into
 * `chatThreads$`.
 *
 * Root cause: `navigateToAdjacentThread$` (chat-keyboard.ts) reads
 * `chatThreads$` directly. The optimistic thread lives only in
 * `allPendingChatThreads$` / `sidebarChatThreads$` until the server-side
 * round-trip arrives, so `findIndex(currentThreadId)` returns -1 and the
 * command early-returns without navigating.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PERSISTED_THREAD_ID = "p0000000-0000-4000-a000-000000000099";

function getSidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

function paneFor(threadId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

describe("sidebar new-chat keyboard navigation", () => {
  it("mod+shift+ArrowDown from a freshly-created optimistic thread navigates to the next persisted thread", async () => {
    // Hold the create POST so the optimistic entry stays registered for the
    // entire test — without it, `routeOptimisticChatThread$` may clear the
    // optimistic before route load promotes `currentChatThreadId$`.
    const createDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      // Persisted list never updates during the test — this simulates the
      // window before the server's `threadListChanged` reload arrives.
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          threads: [
            {
              id: PERSISTED_THREAD_ID,
              title: "Persisted thread",
              agent: { id: AGENT_ID, avatarUrl: null },
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
              isRead: true,
              isArchived: false,
              running: false,
            },
          ],
        });
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
          title: params.id === PERSISTED_THREAD_ID ? "Persisted thread" : null,
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

    // Wait until the sidebar's "+ New chat" button is mounted.
    await waitFor(() => {
      expect(
        within(getSidebar()).getByLabelText(/^New chat with /i),
      ).toBeInTheDocument();
    });

    // Click the sidebar "+ New chat" button.
    click(within(getSidebar()).getByLabelText(/^New chat with /i));

    // The optimistic flow navigates to /chats/<newId>; capture the new id from
    // the URL once it lands.
    let newThreadId = "";
    await waitFor(() => {
      const m = pathname().match(/^\/chats\/([^/?#]+)$/);
      expect(m).not.toBeNull();
      newThreadId = m![1];
      // The chat-thread pane for the new thread should have rendered too.
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${newThreadId}"]`,
        ),
      ).not.toBeNull();
    });
    expect(newThreadId).not.toBe(PERSISTED_THREAD_ID);

    // Sanity: both rows are visible in the sidebar (sidebarChatThreads$ now
    // unifies persisted + optimistic).
    await waitFor(() => {
      expect(
        getSidebar().querySelector(
          `[data-chat-thread-id="${PERSISTED_THREAD_ID}"]`,
        ),
      ).not.toBeNull();
      expect(
        getSidebar().querySelector(`[data-chat-thread-id="${newThreadId}"]`),
      ).not.toBeNull();
    });

    // The freshly-created optimistic thread sits at the top (newest). Press
    // mod+shift+ArrowDown to navigate to the next thread (persisted).
    fireEvent.keyDown(paneFor(newThreadId), {
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
    });

    // BUG: the keyboard handler reads chatThreads$ (server list), which still
    // contains only the persisted thread. The current thread id is the
    // optimistic one, so `findIndex` returns -1 and the command does nothing.
    // EXPECTED (post-fix): navigation lands on the persisted thread.
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${PERSISTED_THREAD_ID}`);
    });

    // Let the still-suspended create POST settle so signal teardown can
    // unwind cleanly.
    createDeferred.resolve();
  });
});
