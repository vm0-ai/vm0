import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openChatIdb } from "../../../signals/external/chat-idb-store.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const FIRST_THREAD_ID = "b0000000-0000-4000-a000-000000000731";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000732";
const FIRST_MESSAGE = "Persist this remote response for thread re-entry";

function threadLink(title: string): HTMLAnchorElement {
  const link = screen.getByText(title).closest("a");
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Thread link not found: ${title}`);
  }
  return link;
}

describe("chat message persistence", () => {
  it("restores remotely fetched messages from IndexedDB when returning to a thread", async () => {
    const testDb = await openChatIdb("idb-reentry-user", "idb-reentry-org");
    const user = userEvent.setup({ delay: null });
    const blockedRemote = context.mocks.deferred<void>();
    let firstThreadCaughtUp = false;
    let blockFirstThreadRemote = false;
    const lifecycle = mockChatLifecycle(context, {
      threadId: FIRST_THREAD_ID,
      threadTitle: "IndexedDB source thread",
    });
    lifecycle.setThreadList([
      {
        id: FIRST_THREAD_ID,
        title: "IndexedDB source thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-06-09T10:00:00Z",
        updatedAt: "2026-06-09T10:01:00Z",
        running: false,
      },
      {
        id: SECOND_THREAD_ID,
        title: "IndexedDB other thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-06-09T10:00:00Z",
        updatedAt: "2026-06-09T10:00:00Z",
        running: false,
      },
    ]);
    context.mocks.api(
      chatThreadMessagesContract.list,
      async ({ params, query, respond }) => {
        if (params.threadId === FIRST_THREAD_ID) {
          if (blockFirstThreadRemote) {
            await blockedRemote.promise;
          }
          if (query.sinceId) {
            firstThreadCaughtUp = true;
            return respond(200, { messages: [] });
          }
          return respond(200, {
            messages: [
              {
                id: "00000000-0000-4000-8000-000000000731",
                role: "assistant",
                content: FIRST_MESSAGE,
                createdAt: "2026-06-09T10:01:00Z",
              },
            ],
            hasHistoryBefore: false,
          });
        }
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages: [
            {
              id: "00000000-0000-4000-8000-000000000732",
              role: "assistant",
              content: "Other thread response",
              createdAt: "2026-06-09T10:00:00Z",
            },
          ],
          hasHistoryBefore: false,
        });
      },
    );

    try {
      detachedSetupPage({
        context,
        path: `/chats/${FIRST_THREAD_ID}`,
        user: { id: "idb-reentry-user", fullName: "IndexedDB Test User" },
        org: {
          activeOrg: { id: "idb-reentry-org", name: "IndexedDB Test Org" },
          memberships: [{ id: "idb-reentry-org" }],
        },
      });

      await waitFor(() => {
        expect(screen.getByText(FIRST_MESSAGE)).toBeInTheDocument();
        expect(firstThreadCaughtUp).toBeTruthy();
      });

      await user.click(threadLink("IndexedDB other thread"));
      await waitFor(() => {
        expect(document.title).toBe("IndexedDB other thread | VM0");
        expect(screen.getByText("Other thread response")).toBeInTheDocument();
      });

      blockFirstThreadRemote = true;
      await user.click(threadLink("IndexedDB source thread"));

      await waitFor(() => {
        expect(document.title).toBe("IndexedDB source thread | VM0");
        expect(screen.getByText(FIRST_MESSAGE)).toBeInTheDocument();
      });
    } finally {
      blockedRemote.resolve();
      testDb.close();
    }
  });
});
