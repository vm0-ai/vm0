import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

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
const FIRST_MESSAGE_ID = "00000000-0000-4000-8000-000000000731";
const FIRST_MESSAGE = "Persist this remote response for thread re-entry";
const STRUCTURED_MESSAGE_ID = "00000000-0000-4000-8000-000000000733";
const STRUCTURED_MESSAGE = "Legacy structured content should stay hidden";
const STRUCTURED_REFERENCE_TITLE = "Archived IndexedDB source";
function structuredPromptFixture(): UserMessageDocument {
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

describe("chat message persistence", () => {
  it("round-trips structured and legacy messages through IndexedDB on thread re-entry", async () => {
    mockUser(
      { id: "idb-reentry-user", fullName: "IndexedDB Test User" },
      { token: "test-token" },
    );
    mockOrganization({
      activeOrg: { id: "idb-reentry-org", name: "IndexedDB Test Org" },
      memberships: [{ id: "idb-reentry-org" }],
    });
    const appDb = await context.store.get(chatIdb$);
    const structuredPrompt = structuredPromptFixture();
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
                id: STRUCTURED_MESSAGE_ID,
                threadId: FIRST_THREAD_ID,
                eventType: "input.prompt" as const,
                role: "user",
                content: STRUCTURED_MESSAGE,
                runId: "d0000000-0000-4000-a000-000000000731",
                structuredPrompt,
                createdAt: "2026-06-09T10:00:00Z",
                seqId: 1,
              },
              {
                id: FIRST_MESSAGE_ID,
                threadId: FIRST_THREAD_ID,
                eventType: "output.message" as const,
                role: "assistant",
                content: FIRST_MESSAGE,
                runId: "d0000000-0000-4000-a000-000000000731",
                createdAt: "2026-06-09T10:01:00Z",
                seqId: 2,
              },
            ],
            hasHistoryBefore: false,
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
              role: "assistant",
              content: "Other thread response",
              createdAt: "2026-06-09T10:00:00Z",
              seqId: 1,
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
        featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
        user: { id: "idb-reentry-user", fullName: "IndexedDB Test User" },
        org: {
          activeOrg: { id: "idb-reentry-org", name: "IndexedDB Test Org" },
          memberships: [{ id: "idb-reentry-org" }],
        },
      });

      await firstThreadCaughtUp.promise;
      await expect(
        screen.findByText(FIRST_MESSAGE),
      ).resolves.toBeInTheDocument();
      await waitFor(() => {
        const reference = document.querySelector(
          `a[aria-label="Open chat ${STRUCTURED_REFERENCE_TITLE}"]`,
        );
        expect(reference).toHaveAttribute("href", `/chats/${FIRST_THREAD_ID}`);
      });
      expect(screen.queryByText(STRUCTURED_MESSAGE)).not.toBeInTheDocument();
      await waitFor(async () => {
        const testDb = await openChatIdb("idb-reentry-user", "idb-reentry-org");
        try {
          const structuredMessage: unknown = await testDb.get(
            CHAT_MESSAGES_STORE,
            STRUCTURED_MESSAGE_ID,
          );
          expect(structuredMessage).toMatchObject({
            content: STRUCTURED_MESSAGE,
            structuredPrompt,
            threadId: FIRST_THREAD_ID,
          });
          const persistedMessage: unknown = await testDb.get(
            CHAT_MESSAGES_STORE,
            FIRST_MESSAGE_ID,
          );
          expect(persistedMessage).toMatchObject({
            content: FIRST_MESSAGE,
            threadId: FIRST_THREAD_ID,
          });
          expect(persistedMessage).not.toHaveProperty("structuredPrompt");
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
        expect(screen.getByText(FIRST_MESSAGE)).toBeInTheDocument();
        const reference = document.querySelector(
          `a[aria-label="Open chat ${STRUCTURED_REFERENCE_TITLE}"]`,
        );
        expect(reference).toHaveAttribute("href", `/chats/${FIRST_THREAD_ID}`);
        expect(screen.queryByText(STRUCTURED_MESSAGE)).not.toBeInTheDocument();
      });
    } finally {
      blockedRemote.resolve();
      appDb.close();
    }
  });

  it("falls back to the remote message list when cached structured data is invalid", async () => {
    const userId = "idb-invalid-user";
    const orgId = "idb-invalid-org";
    const threadId = "b0000000-0000-4000-a000-000000000734";
    const remoteMessage = "Reloaded after invalid structured cache";
    const cachedMessage = "Invalid cached structured message";
    const remoteMessagesCaughtUp = context.mocks.deferred<void>();
    const testDb = await openChatIdb(userId, orgId);
    try {
      await testDb.put(CHAT_MESSAGES_STORE, {
        id: "00000000-0000-4000-8000-000000000734",
        eventType: "input.prompt" as const,
        role: "user",
        content: cachedMessage,
        structuredPrompt: { version: 1, parts: [] },
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
        if (!remoteMessagesCaughtUp.settled()) {
          remoteMessagesCaughtUp.resolve();
        }
        return respond(200, { events: [] });
      }
      return respond(200, {
        events: [
          {
            id: "00000000-0000-4000-8000-000000000735",
            threadId,
            eventType: "input.prompt" as const,
            role: "user",
            content: remoteMessage,
            createdAt: "2026-06-09T10:01:00Z",
            seqId: 1,
          },
        ],
        hasHistoryBefore: false,
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

      await remoteMessagesCaughtUp.promise;
      await expect(
        screen.findByText(remoteMessage),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByText(cachedMessage)).not.toBeInTheDocument();
    } finally {
      appDb.close();
    }
  });
});
