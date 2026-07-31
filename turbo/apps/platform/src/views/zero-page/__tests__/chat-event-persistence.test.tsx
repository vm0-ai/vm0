import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

import { mockOrganization, mockUser } from "../../../__tests__/mock-auth.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { CHAT_MESSAGES_STORE } from "../../../signals/external/chat-idb-schema.ts";
import {
  chatIdb$,
  openChatIdb,
} from "../../../signals/external/chat-idb-store.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const FIRST_THREAD_ID = "b0000000-0000-4000-a000-000000000731";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000732";
const FIRST_EVENT_ID = "00000000-0000-4000-8000-000000000731";
const FIRST_EVENT_CONTENT = "Persist this remote response for thread re-entry";
const STRUCTURED_EVENT_ID = "00000000-0000-4000-8000-000000000733";
const GOAL_QUEUE_EVENT_ID = "00000000-0000-4000-8000-000000000734";
const STRUCTURED_REFERENCE_TITLE = "Archived IndexedDB source";
function userMessageFixture(): UserMessageDocument {
  return {
    version: 1,
    parts: [
      { type: "text", text: "Use " },
      {
        type: "chat_thread",
        threadId: FIRST_THREAD_ID,
        titleSnapshot: STRUCTURED_REFERENCE_TITLE,
      },
      { type: "text", text: " for context" },
    ],
  };
}

async function findThreadLink(title: string): Promise<HTMLAnchorElement> {
  const link = (await screen.findByText(title)).closest("a");
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Thread link not found: ${title}`);
  }
  return link;
}

describe("chat event persistence", () => {
  it("round-trips canonical user and assistant events through IndexedDB on thread re-entry", async () => {
    mockUser(
      { id: "idb-reentry-user", fullName: "IndexedDB Test User" },
      { token: "test-token" },
    );
    mockOrganization({
      activeOrg: { id: "idb-reentry-org", name: "IndexedDB Test Org" },
      memberships: [{ id: "idb-reentry-org" }],
    });
    const appDb = await context.store.get(chatIdb$);
    const userMessage = userMessageFixture();
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
      },
      {
        id: SECOND_THREAD_ID,
        title: "IndexedDB other thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-06-09T10:00:00Z",
        updatedAt: "2026-06-09T10:00:00Z",
      },
    ]);
    context.mocks.api(
      chatThreadEventsContract.list,
      async ({ params, query, respond }) => {
        if (params.threadId === FIRST_THREAD_ID) {
          if (blockFirstThreadRemote) {
            await blockedRemote.promise;
          }
          if (query.sinceSeqId) {
            if (!firstThreadCaughtUp.settled()) {
              firstThreadCaughtUp.resolve();
            }
            return respond(200, { events: [] });
          }
          return respond(200, {
            events: [
              {
                id: GOAL_QUEUE_EVENT_ID,
                threadId: FIRST_THREAD_ID,
                eventType: "input.goal" as const,
                content: null,
                userMessage: {
                  version: 1 as const,
                  parts: [
                    {
                      type: "goal" as const,
                      goalBrief: "Persist this goal queue marker",
                    },
                  ],
                },
                createdAt: "2026-06-09T09:59:00Z",
                seqId: 1,
              },
              {
                id: STRUCTURED_EVENT_ID,
                threadId: FIRST_THREAD_ID,
                eventType: "input.prompt" as const,
                content: null,
                runId: "d0000000-0000-4000-a000-000000000731",
                userMessage,
                createdAt: "2026-06-09T10:00:00Z",
                seqId: 2,
              },
              {
                id: FIRST_EVENT_ID,
                threadId: FIRST_THREAD_ID,
                eventType: "output.message" as const,
                content: FIRST_EVENT_CONTENT,
                runId: "d0000000-0000-4000-a000-000000000731",
                createdAt: "2026-06-09T10:01:00Z",
                seqId: 3,
              },
            ],
          });
        }
        if (query.sinceSeqId || query.sinceId) {
          return respond(200, { events: [] });
        }
        return respond(200, {
          events: [
            {
              id: "00000000-0000-4000-8000-000000000732",
              threadId: SECOND_THREAD_ID,
              eventType: "output.message" as const,
              content: "Other thread response",
              createdAt: "2026-06-09T10:00:00Z",
              seqId: 1,
            },
          ],
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

      await firstThreadCaughtUp.promise;
      await expect(
        screen.findByText(FIRST_EVENT_CONTENT),
      ).resolves.toBeInTheDocument();
      await waitFor(() => {
        const reference = document.querySelector(
          `a[aria-label="Open chat ${STRUCTURED_REFERENCE_TITLE}"]`,
        );
        expect(reference).toHaveAttribute("href", `/chats/${FIRST_THREAD_ID}`);
        expect(document.querySelectorAll('[data-role="user"]')).toHaveLength(1);
      });
      await waitFor(async () => {
        const testDb = await openChatIdb("idb-reentry-user", "idb-reentry-org");
        try {
          const goalQueueEvent: unknown = await testDb.get(
            CHAT_MESSAGES_STORE,
            GOAL_QUEUE_EVENT_ID,
          );
          expect(goalQueueEvent).toMatchObject({
            eventType: "input.goal",
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "goal",
                  goalBrief: "Persist this goal queue marker",
                },
              ],
            },
            seqId: 1,
            threadId: FIRST_THREAD_ID,
          });
          const userMessageElement: unknown = await testDb.get(
            CHAT_MESSAGES_STORE,
            STRUCTURED_EVENT_ID,
          );
          expect(userMessageElement).toMatchObject({
            content: null,
            userMessage,
            threadId: FIRST_THREAD_ID,
          });
          const persistedEvent: unknown = await testDb.get(
            CHAT_MESSAGES_STORE,
            FIRST_EVENT_ID,
          );
          expect(persistedEvent).toMatchObject({
            content: FIRST_EVENT_CONTENT,
            threadId: FIRST_THREAD_ID,
          });
          expect(persistedEvent).not.toHaveProperty("userMessage");
        } finally {
          testDb.close();
        }
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
        expect(screen.getByText(FIRST_EVENT_CONTENT)).toBeInTheDocument();
        const reference = document.querySelector(
          `a[aria-label="Open chat ${STRUCTURED_REFERENCE_TITLE}"]`,
        );
        expect(reference).toHaveAttribute("href", `/chats/${FIRST_THREAD_ID}`);
      });
    } finally {
      blockedRemote.resolve();
      appDb.close();
    }
  });

  it("falls back to the remote event list when cached structured data is invalid", async () => {
    const userId = "idb-invalid-user";
    const orgId = "idb-invalid-org";
    const threadId = "b0000000-0000-4000-a000-000000000734";
    const remoteEventContent = "Reloaded after invalid structured cache";
    const cachedEventContent = "Invalid cached structured message";
    const remoteEventsCaughtUp = context.mocks.deferred<void>();
    const testDb = await openChatIdb(userId, orgId);
    try {
      await testDb.put(CHAT_MESSAGES_STORE, {
        id: "00000000-0000-4000-8000-000000000734",
        eventType: "input.prompt" as const,
        content: cachedEventContent,
        userMessage: { version: 1, parts: [] },
        createdAt: "2026-06-09T10:00:00Z",
        threadId,
        orderSequence: -1,
      });
    } finally {
      testDb.close();
    }
    mockUser(
      { id: userId, fullName: "Invalid IndexedDB Test User" },
      { token: "test-token" },
    );
    mockOrganization({
      activeOrg: { id: orgId, name: "Invalid IndexedDB Test Org" },
      memberships: [{ id: orgId }],
    });
    const appDb = await context.store.get(chatIdb$);

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Invalid IndexedDB cache",
    });
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      if (query.sinceSeqId) {
        if (!remoteEventsCaughtUp.settled()) {
          remoteEventsCaughtUp.resolve();
        }
        return respond(200, { events: [] });
      }
      return respond(200, {
        events: [
          {
            id: "00000000-0000-4000-8000-000000000735",
            threadId,
            eventType: "input.prompt" as const,
            content: null,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: remoteEventContent }],
            },
            createdAt: "2026-06-09T10:01:00Z",
            seqId: 1,
          },
        ],
      });
    });

    try {
      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        user: { id: userId, fullName: "Invalid IndexedDB Test User" },
        org: {
          activeOrg: { id: orgId, name: "Invalid IndexedDB Test Org" },
          memberships: [{ id: orgId }],
        },
      });

      await remoteEventsCaughtUp.promise;
      await expect(
        screen.findByText(remoteEventContent),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByText(cachedEventContent)).not.toBeInTheDocument();
    } finally {
      appDb.close();
    }
  });
});
