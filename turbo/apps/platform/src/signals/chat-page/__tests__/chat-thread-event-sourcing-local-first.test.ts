import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  chatThreads$,
  currentChatThreadListIds$,
  reloadChatThreads$,
  setChatAgentId$,
} from "../../agent-chat.ts";
import { renameDialogInput$ } from "../../zero-page/zero-sidebar-state.ts";
import { sidebarChatThreadIds$ } from "../sidebar-chat-thread-ids.ts";
import { setChatThreadOnlyUnread$ } from "../chat-thread-only-unread.ts";
import { openRenameChatThreadDialogFromThreadData$ } from "../chat-thread-rename.ts";
import {
  registerOptimisticChatThreadEvent$,
  threadMeta,
} from "../chat-thread-event-sourcing.ts";
import { createIdbCachedDataSource } from "../idb-cached-chat-thread-data-source.ts";

const idbThreadEventStoreMock = vi.hoisted(() => {
  let snapshot: {
    readonly chatThreads: readonly ChatThreadSnapshotProjection[];
    readonly latestEventId: string | null;
  } | null = null;
  let events: readonly ChatThreadEvent[] = [];

  const readSnapshot = vi.fn(() => {
    return Promise.resolve(snapshot);
  });
  const readLatestEventId = vi.fn(() => {
    return Promise.resolve(snapshot?.latestEventId ?? null);
  });
  const readEvents = vi.fn(() => {
    return Promise.resolve(events);
  });
  const replaceFromSnapshot = vi.fn(
    (nextSnapshot: {
      readonly chatThreads: readonly ChatThreadSnapshotProjection[];
      readonly latestEventId: string | null;
    }) => {
      snapshot = nextSnapshot;
      events = [];
      return Promise.resolve();
    },
  );
  const upsertEvents = vi.fn((nextEvents: readonly ChatThreadEvent[]) => {
    const byId = new Map(
      events.map((event) => {
        return [event.id, event] as const;
      }),
    );
    for (const event of nextEvents) {
      byId.set(event.id, event);
    }
    events = [...byId.values()];
    return Promise.resolve();
  });

  return {
    readSnapshot,
    readLatestEventId,
    readEvents,
    replaceFromSnapshot,
    upsertEvents,
    setData(args: {
      readonly snapshot: {
        readonly chatThreads: readonly ChatThreadSnapshotProjection[];
        readonly latestEventId: string | null;
      } | null;
      readonly events?: readonly ChatThreadEvent[];
    }) {
      snapshot = args.snapshot;
      events = args.events ?? [];
    },
    reset() {
      snapshot = null;
      events = [];
      readSnapshot.mockClear();
      readLatestEventId.mockClear();
      readEvents.mockClear();
      replaceFromSnapshot.mockClear();
      upsertEvents.mockClear();
    },
  };
});

vi.mock("../../external/idb-chat-thread-event-store.ts", () => {
  return {
    createIdbChatThreadEventStores: () => {
      return {
        readStore: {
          readSnapshot: idbThreadEventStoreMock.readSnapshot,
          readLatestEventId: idbThreadEventStoreMock.readLatestEventId,
          readEvents: idbThreadEventStoreMock.readEvents,
        },
        writeStore: {
          replaceFromSnapshot: idbThreadEventStoreMock.replaceFromSnapshot,
          upsertEvents: idbThreadEventStoreMock.upsertEvents,
        },
      };
    },
  };
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const OPTIMISTIC_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const EVENT_ID = "d0000000-0000-4000-a000-000000000001";
const OPTIMISTIC_EVENT_ID = "d0000000-0000-4000-a000-000000000002";

function expectCallback(callback: (() => void) | null): () => void {
  expect(callback).not.toBeNull();
  if (!callback) {
    throw new Error("Expected callback to be set");
  }
  return callback;
}

describe("chat thread event sourcing local-first list", () => {
  afterEach(() => {
    context.store.set(setChatThreadOnlyUnread$, false);
    idbThreadEventStoreMock.reset();
  });

  it("does not start remote event sync on signed-out pages", async () => {
    let activeIdsRequests = 0;
    let eventsRequests = 0;
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      activeIdsRequests += 1;
      return respond(200, { threadIds: [] });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      eventsRequests += 1;
      return respond(200, { events: [], hasMore: false });
    });

    await setupPage({
      context,
      path: "/sign-in",
      withoutRender: true,
      user: null,
      session: null,
      org: { activeOrg: null, memberships: [] },
    });

    expect(activeIdsRequests).toBe(0);
    expect(eventsRequests).toBe(0);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("renders cached thread list data while event sync is blocked", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Cached old title",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
          },
        ],
      },
      events: [
        {
          id: EVENT_ID,
          kind: "renamed",
          chatThreadId: THREAD_ID,
          agentId: AGENT_ID,
          title: "Cached renamed title",
          createdAt: "2026-07-03T03:00:00.000Z",
        },
      ],
    });

    let eventsRequests = 0;
    let teamRequests = 0;
    let unblockEventsRequest: (() => void) | null = null;
    context.mocks.api(
      chatThreadsContract.events,
      async ({ deferred, respond }) => {
        eventsRequests += 1;
        const blocked = deferred<void>();
        unblockEventsRequest = () => {
          blocked.resolve(undefined);
        };
        await blocked.promise;
        return respond(200, { events: [], hasMore: false });
      },
    );
    context.mocks.api(zeroTeamContract.list, ({ never }) => {
      teamRequests += 1;
      return never();
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    await vi.waitFor(() => {
      expect(eventsRequests).toBe(1);
    });

    const threads = await context.store.get(chatThreads$);

    expect(threads).toStrictEqual([
      {
        id: THREAD_ID,
        title: "Cached renamed title",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-07-03T01:00:00.000Z",
        updatedAt: "2026-07-03T03:00:00.000Z",
        running: false,
        pinnedAt: null,
        renamedAt: "2026-07-03T03:00:00.000Z",
      },
    ]);
    expect(eventsRequests).toBe(1);
    expect(teamRequests).toBe(0);
    expectCallback(unblockEventsRequest)();
  });

  it("filters event-sourced visible threads through unread thread ids", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);
    context.store.set(setChatThreadOnlyUnread$, true);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Unread cached thread",
            sortAt: "2026-07-03T03:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T03:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
          },
          {
            id: OTHER_THREAD_ID,
            agentId: AGENT_ID,
            title: "Read cached thread",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
          },
        ],
      },
      events: [],
    });

    let unreadsRequests = 0;
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [] });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      unreadsRequests += 1;
      return respond(200, {
        unreads: [
          {
            threadId: THREAD_ID,
            unreadAt: "2026-07-03T04:00:00.000Z",
          },
        ],
      });
    });
    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
      featureSwitches: {
        [FeatureSwitchKey.AgentUnreadIndicators]: true,
      },
    });

    const threads = await context.store.get(chatThreads$);

    expect(
      threads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([THREAD_ID]);
    expect(unreadsRequests).toBe(1);
  });

  it("keeps sidebar threads and navigation ids untruncated", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);
    const baseTime = Date.parse("2026-07-03T00:00:00.000Z");
    const snapshotThreads = Array.from({ length: 26 }, (_, index) => {
      const timestamp = new Date(baseTime + (26 - index) * 1000).toISOString();
      return {
        id: `b1000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        agentId: AGENT_ID,
        title: `Cached thread ${index + 1}`,
        sortAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        pinnedAt: null,
        renamedAt: null,
      } satisfies ChatThreadSnapshotProjection;
    });

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: snapshotThreads,
      },
      events: [],
    });

    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [] });
    });
    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    const visibleThreads = await context.store.get(chatThreads$);

    expect(visibleThreads).toHaveLength(snapshotThreads.length);
    await expect(
      context.store.get(currentChatThreadListIds$),
    ).resolves.toStrictEqual(
      snapshotThreads.map((thread) => {
        return thread.id;
      }),
    );
  });

  it("uses optimistic create events for event-sourced sidebar ids", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: null,
        chatThreads: [],
      },
      events: [],
    });

    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [] });
    });
    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    context.store.set(registerOptimisticChatThreadEvent$, {
      id: OPTIMISTIC_EVENT_ID,
      kind: "created",
      chatThreadId: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      createdAt: "2026-07-03T05:00:00.000Z",
    });

    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([OPTIMISTIC_THREAD_ID]);
    await expect(context.store.get(chatThreads$)).resolves.toStrictEqual([
      {
        id: OPTIMISTIC_THREAD_ID,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-07-03T05:00:00.000Z",
        updatedAt: "2026-07-03T05:00:00.000Z",
        running: false,
        pinnedAt: null,
        renamedAt: null,
      },
    ]);
    await expect(
      context.store.get(threadMeta(OPTIMISTIC_THREAD_ID)),
    ).resolves.toStrictEqual({
      id: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      pinnedAt: null,
    });

    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      expect(params.id).toBe(OPTIMISTIC_THREAD_ID);
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    });

    const dataSource = createIdbCachedDataSource(OPTIMISTIC_THREAD_ID);
    await expect(context.store.get(dataSource.getThread$)).resolves.toBeNull();
  });

  it("settles optimistic create events once the matching persisted event arrives", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [],
      },
      events: [],
    });

    const createdEvent = {
      id: OPTIMISTIC_EVENT_ID,
      kind: "created",
      chatThreadId: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      createdAt: "2026-07-03T05:00:00.000Z",
    } satisfies ChatThreadEvent;

    context.store.set(registerOptimisticChatThreadEvent$, createdEvent);

    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [createdEvent], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [] });
    });
    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    await vi.waitFor(() => {
      expect(idbThreadEventStoreMock.upsertEvents).toHaveBeenCalledWith(
        [createdEvent],
        expect.any(AbortSignal),
      );
    });
    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([OPTIMISTIC_THREAD_ID]);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [],
      },
      events: [],
    });
    context.store.set(reloadChatThreads$);

    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([]);
  });

  it("prefills rename dialog title from provided event-driven thread metadata", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Cached old title",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
          },
        ],
      },
      events: [
        {
          id: EVENT_ID,
          kind: "renamed",
          chatThreadId: THREAD_ID,
          agentId: AGENT_ID,
          title: "Cached renamed title",
          createdAt: "2026-07-03T03:00:00.000Z",
        },
      ],
    });

    let detailRequests = 0;
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ never }) => {
      detailRequests += 1;
      return never();
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: "user_1", fullName: "Test User" },
      session: { token: "token" },
      org: {
        activeOrg: { id: "org_1", name: "Test Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    detailRequests = 0;
    await context.store.set(
      openRenameChatThreadDialogFromThreadData$,
      {
        threadId: THREAD_ID,
        title: "Cached renamed title",
        agentId: AGENT_ID,
      },
      context.signal,
    );

    expect(context.store.get(renameDialogInput$)).toBe("Cached renamed title");
    expect(detailRequests).toBe(0);
  });
});
