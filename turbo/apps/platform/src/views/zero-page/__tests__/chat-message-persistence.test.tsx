import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { CHAT_MESSAGES_STORE } from "../../../signals/external/chat-idb-schema.ts";
import { openChatIdb } from "../../../signals/external/chat-idb-store.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

vi.mock("signal-timers", async () => {
  const actual =
    await vi.importActual<typeof import("signal-timers")>("signal-timers");

  return {
    ...actual,
    async delay(
      milliseconds: number,
      options?: Parameters<typeof actual.delay>[1],
    ): Promise<void> {
      // Timeout fallback has its own integration test. Keep this cache-hit test
      // independent of wall-clock contention while exercising real IndexedDB.
      if (milliseconds !== 200) {
        await actual.delay(milliseconds, options);
        return;
      }

      const signal = options?.signal;
      signal?.throwIfAborted();
      const { promise, reject } = Promise.withResolvers<void>();
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
      await promise;
    },
  };
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const FIRST_THREAD_ID = "b0000000-0000-4000-a000-000000000731";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000732";
const FIRST_USER_MESSAGE_ID = "00000000-0000-4000-8000-000000000730";
const FIRST_ASSISTANT_MESSAGE_ID = "00000000-0000-4000-8000-000000000731";
const FIRST_USER_MESSAGE = "Persist this request before the remote response";
const FIRST_ASSISTANT_MESSAGE =
  "Persist this remote response for thread re-entry";

async function findThreadLink(title: string): Promise<HTMLAnchorElement> {
  const link = (await screen.findByText(title)).closest("a");
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
    const firstThreadCaughtUp = context.mocks.deferred<void>();
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
            if (!firstThreadCaughtUp.settled()) {
              firstThreadCaughtUp.resolve();
            }
            return respond(200, { messages: [] });
          }
          return respond(200, {
            messages: [
              {
                id: FIRST_USER_MESSAGE_ID,
                role: "user",
                content: FIRST_USER_MESSAGE,
                createdAt: "2026-06-09T10:00:00Z",
              },
              {
                id: FIRST_ASSISTANT_MESSAGE_ID,
                role: "assistant",
                content: FIRST_ASSISTANT_MESSAGE,
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

      await expect(
        screen.findByText(FIRST_ASSISTANT_MESSAGE),
      ).resolves.toBeInTheDocument();
      await firstThreadCaughtUp.promise;
      await waitFor(async () => {
        const [persistedUserMessage, persistedAssistantMessage]: unknown[] =
          await Promise.all([
            testDb.get(CHAT_MESSAGES_STORE, FIRST_USER_MESSAGE_ID),
            testDb.get(CHAT_MESSAGES_STORE, FIRST_ASSISTANT_MESSAGE_ID),
          ]);
        expect(persistedUserMessage).toMatchObject({
          content: FIRST_USER_MESSAGE,
          threadId: FIRST_THREAD_ID,
        });
        expect(persistedAssistantMessage).toMatchObject({
          content: FIRST_ASSISTANT_MESSAGE,
          threadId: FIRST_THREAD_ID,
        });
      });

      await user.click(await findThreadLink("IndexedDB other thread"));
      await waitFor(() => {
        expect(document.title).toBe("IndexedDB other thread | VM0");
        expect(screen.getByText("Other thread response")).toBeInTheDocument();
      });

      blockFirstThreadRemote = true;
      await user.click(await findThreadLink("IndexedDB source thread"));

      await waitFor(() => {
        expect(document.title).toBe("IndexedDB source thread | VM0");
        expect(screen.getByText(FIRST_USER_MESSAGE)).toBeInTheDocument();
        expect(screen.getByText(FIRST_ASSISTANT_MESSAGE)).toBeInTheDocument();
      });
    } finally {
      blockedRemote.resolve();
      testDb.close();
    }
  });
});
