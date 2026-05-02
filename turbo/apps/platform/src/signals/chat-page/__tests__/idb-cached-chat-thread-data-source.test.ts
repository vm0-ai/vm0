import { describe, it, expect, beforeEach } from "vitest";
import {
  mockUser,
  mockOrganization,
  clearMockedAuth,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { server } from "../../../mocks/server.ts";
import {
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createIdbCachedDataSource } from "../idb-cached-chat-thread-data-source.ts";
import { createIdbMessageStores } from "../../external/idb-message-store.ts";

const context = testContext();
const mockApi = createMockApi(context);

function makeMsg(
  id: string,
  _threadId: string,
  createdAt: string,
): PagedChatMessage {
  return {
    id,
    role: "user" as const,
    content: `msg ${id}`,
    createdAt,
  };
}

const USER_ID = "test-idb-cache-user";
const ORG_ID = "test-idb-cache-org";

function setupAuth() {
  mockUser({ id: USER_ID, fullName: "Test User" }, { token: "test-token" });
  mockOrganization({
    activeOrg: { id: ORG_ID, name: "Test Org" },
  });
}

describe("createIdbCachedDataSource.listMessagesAfter$", () => {
  beforeEach(() => {
    clearMockedAuth();
    setupAuth();
  });

  it("caches remote messages when sinceId anchor exists in local IDB", async () => {
    const threadId = "thread-anchor-exists";

    // Pre-populate IDB with the anchor message
    const stores = createIdbMessageStores(USER_ID, ORG_ID);
    await stores.writeStore.upsertMessages(threadId, [
      makeMsg("anchor-1", threadId, "2026-01-01T00:00:00Z"),
    ]);

    // Set up remote to return messages after the anchor
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId === "anchor-1") {
          return respond(200, {
            messages: [
              makeMsg("new-1", threadId, "2026-01-02T00:00:00Z"),
              makeMsg("new-2", threadId, "2026-01-03T00:00:00Z"),
            ],
          });
        }
        return respond(200, { messages: [] });
      }),
    );

    const ds = createIdbCachedDataSource(threadId);

    const result = await context.store.set(
      ds.listMessagesAfter$,
      { threadId, sinceId: "anchor-1" },
      context.signal,
    );

    expect(result.messages).toHaveLength(2);

    // Anchor existed → messages should be cached
    const cached = await stores.readStore.readLatest(threadId, 10);
    expect(cached).toHaveLength(3); // anchor + new-1 + new-2
    expect(
      cached
        .map((m) => {
          return m.id;
        })
        .sort(),
    ).toStrictEqual(["anchor-1", "new-1", "new-2"]);
  });

  it("skips caching when sinceId anchor is missing from local IDB", async () => {
    const threadId = "thread-anchor-missing";

    // Do NOT pre-populate IDB — anchor will be missing

    // Set up remote to return messages even though anchor doesn't exist locally
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId === "missing-anchor") {
          return respond(200, {
            messages: [
              makeMsg("gap-1", threadId, "2026-02-01T00:00:00Z"),
              makeMsg("gap-2", threadId, "2026-02-02T00:00:00Z"),
            ],
          });
        }
        return respond(200, { messages: [] });
      }),
    );

    const ds = createIdbCachedDataSource(threadId);
    const stores = createIdbMessageStores(USER_ID, ORG_ID);

    const result = await context.store.set(
      ds.listMessagesAfter$,
      { threadId, sinceId: "missing-anchor" },
      context.signal,
    );

    // Messages are still returned to the UI
    expect(result.messages).toHaveLength(2);

    // But they must NOT be cached (anchor was lost → gap risk)
    const cached = await stores.readStore.readLatest(threadId, 10);
    expect(cached).toHaveLength(0);
  });

  it("caches remote messages when sinceId is undefined (bootstrap)", async () => {
    const threadId = "thread-bootstrap";

    server.use(
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, {
          messages: [
            makeMsg("boot-1", threadId, "2026-03-01T00:00:00Z"),
            makeMsg("boot-2", threadId, "2026-03-02T00:00:00Z"),
          ],
        });
      }),
    );

    const ds = createIdbCachedDataSource(threadId);
    const stores = createIdbMessageStores(USER_ID, ORG_ID);

    const result = await context.store.set(
      ds.listMessagesAfter$,
      { threadId, sinceId: undefined },
      context.signal,
    );

    expect(result.messages).toHaveLength(2);

    // sinceId undefined → no anchor check → always cache
    const cached = await stores.readStore.readLatest(threadId, 10);
    expect(cached).toHaveLength(2);
  });
});
