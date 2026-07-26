import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
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
  setChatAgentId$,
} from "../../agent-chat.ts";
import { renameDialogInput$ } from "../../zero-page/zero-sidebar-state.ts";
import { sidebarChatThreadIds$ } from "../sidebar-chat-thread-ids.ts";
import { setChatThreadOnlyUnread$ } from "../chat-thread-only-unread.ts";
import { openRenameChatThreadDialogFromThreadMeta$ } from "../chat-thread-rename.ts";
import {
  eventDrivenChatThread,
  optimisticChatThreadCreateUnsettled,
  reconcileOptimisticChatThreadEvents$,
  registerOptimisticChatThreadEvent$,
  syncEventDrivenChatThreads$,
  threadMeta,
  touchOptimisticChatThreadSort$,
} from "../chat-thread-event-sourcing.ts";
import { loadIndexedDbChatEvents$ } from "../chat-event-indexed-db.ts";
import { createRemoteChatThreadDataSource } from "../remote-chat-thread-data-source.ts";

const idbThreadEventStoreMock = vi.hoisted(() => {
  let snapshot: {
    readonly chatThreads: readonly ChatThreadSnapshotProjection[];
    readonly latestEventId: string | null;
  } | null = null;
  let events: readonly ChatThreadEvent[] = [];

  const readSnapshot = vi.fn(() => {
    return Promise.resolve(snapshot);
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
const OPTIMISTIC_MODEL_EVENT_ID = "d0000000-0000-4000-a000-000000000003";

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
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
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
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
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
        agentId: AGENT_ID,
        title: "Cached renamed title",
        sortAt: "2026-07-03T02:00:00.000Z",
        createdAt: "2026-07-03T01:00:00.000Z",
        updatedAt: "2026-07-03T03:00:00.000Z",
        pinnedAt: null,
        renamedAt: "2026-07-03T03:00:00.000Z",
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
      },
    ]);
    expect(eventsRequests).toBe(1);
    expect(teamRequests).toBe(0);
    expectCallback(unblockEventsRequest)();
  });

  it("keeps event-sourced thread state stable when incremental sync is empty", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Cached thread",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
      },
      events: [],
    });

    const renamedEvent = {
      id: OPTIMISTIC_EVENT_ID,
      kind: "renamed",
      chatThreadId: THREAD_ID,
      agentId: AGENT_ID,
      title: "Synced thread",
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-03T03:00:00.000Z",
    } satisfies ChatThreadEvent;
    let eventsRequests = 0;
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      eventsRequests += 1;
      if (eventsRequests === 1) {
        return respond(200, { events: [renamedEvent], hasMore: false });
      }
      return respond(200, { events: [], hasMore: false });
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
    await vi.waitFor(async () => {
      expect((await context.store.get(chatThreads$))[0]?.title).toBe(
        "Synced thread",
      );
    });

    const before = await context.store.get(chatThreads$);
    const snapshotReads =
      idbThreadEventStoreMock.readSnapshot.mock.calls.length;
    const eventReads = idbThreadEventStoreMock.readEvents.mock.calls.length;
    idbThreadEventStoreMock.replaceFromSnapshot.mockClear();
    idbThreadEventStoreMock.upsertEvents.mockClear();

    await context.store.set(syncEventDrivenChatThreads$, context.signal);

    const after = await context.store.get(chatThreads$);
    expect(after).toBe(before);
    expect(idbThreadEventStoreMock.readSnapshot).toHaveBeenCalledTimes(
      snapshotReads,
    );
    expect(idbThreadEventStoreMock.readEvents).toHaveBeenCalledTimes(
      eventReads,
    );
    expect(idbThreadEventStoreMock.replaceFromSnapshot).not.toHaveBeenCalled();
    expect(idbThreadEventStoreMock.upsertEvents).not.toHaveBeenCalled();
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
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
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
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
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
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
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

  it("applies optimistic selected model updates over cached thread projections", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Cached model thread",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
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
      kind: "model_selection_updated",
      chatThreadId: THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-03T05:00:00.000Z",
    });

    expect(context.store.get(eventDrivenChatThread(THREAD_ID))).toMatchObject({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
      computerUseHostId: null,
      sortAt: "2026-07-03T02:00:00.000Z",
      updatedAt: "2026-07-03T05:00:00.000Z",
    });
  });

  it("moves cached threads to the top from optimistic sort touches", async () => {
    context.store.set(setChatAgentId$, AGENT_ID);

    idbThreadEventStoreMock.setData({
      snapshot: {
        latestEventId: EVENT_ID,
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "Older cached thread",
            sortAt: "2026-07-03T02:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T02:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
          {
            id: OTHER_THREAD_ID,
            agentId: AGENT_ID,
            title: "Newer cached thread",
            sortAt: "2026-07-03T04:00:00.000Z",
            createdAt: "2026-07-03T01:00:00.000Z",
            updatedAt: "2026-07-03T04:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
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

    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([OTHER_THREAD_ID, THREAD_ID]);

    context.store.set(touchOptimisticChatThreadSort$, {
      id: OPTIMISTIC_EVENT_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      createdAt: "2026-07-03T05:00:00.000Z",
    });

    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([THREAD_ID, OTHER_THREAD_ID]);
    expect(context.store.get(eventDrivenChatThread(THREAD_ID))).toMatchObject({
      sortAt: "2026-07-03T05:00:00.000Z",
    });
  });

  it("uses optimistic create and model update events for event-sourced sidebar ids", async () => {
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

    const createdEvent = {
      id: OPTIMISTIC_EVENT_ID,
      kind: "created",
      chatThreadId: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-03T05:00:00.000Z",
    } satisfies ChatThreadEvent;
    context.store.set(registerOptimisticChatThreadEvent$, createdEvent);
    context.store.set(registerOptimisticChatThreadEvent$, {
      id: OPTIMISTIC_MODEL_EVENT_ID,
      kind: "model_selection_updated",
      chatThreadId: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-03T05:00:01.000Z",
    });

    await expect(
      context.store.get(sidebarChatThreadIds$),
    ).resolves.toStrictEqual([OPTIMISTIC_THREAD_ID]);
    await expect(context.store.get(chatThreads$)).resolves.toStrictEqual([
      {
        id: OPTIMISTIC_THREAD_ID,
        agentId: AGENT_ID,
        title: null,
        sortAt: "2026-07-03T05:00:00.000Z",
        createdAt: "2026-07-03T05:00:00.000Z",
        updatedAt: "2026-07-03T05:00:01.000Z",
        pinnedAt: null,
        renamedAt: null,
        selectedModel: "claude-sonnet-4-6",
        serviceTier: null,
        computerUseHostId: null,
      },
    ]);
    expect(context.store.get(threadMeta(OPTIMISTIC_THREAD_ID))).toStrictEqual({
      id: OPTIMISTIC_THREAD_ID,
      agentId: AGENT_ID,
      title: null,
      pinnedAt: null,
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
      computerUseHostId: null,
    });

    let threadDraftRequests = 0;
    let initialMessagesRequests = 0;
    context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
      threadDraftRequests += 1;
      expect(params.id).toBe(OPTIMISTIC_THREAD_ID);
      return respond(200, {
        draftContent: null,
        draftAttachments: null,
      });
    });
    context.mocks.api(chatThreadEventsContract.list, ({ params, respond }) => {
      initialMessagesRequests += 1;
      expect(params.threadId).toBe(OPTIMISTIC_THREAD_ID);
      return respond(200, { events: [], hasHistoryBefore: false });
    });

    const dataSource = createRemoteChatThreadDataSource(OPTIMISTIC_THREAD_ID);
    await expect(
      context.store.get(dataSource.threadDraft$),
    ).resolves.toBeNull();
    await expect(
      context.store.set(
        loadIndexedDbChatEvents$,
        OPTIMISTIC_THREAD_ID,
        context.signal,
      ),
    ).resolves.toStrictEqual([]);
    expect(threadDraftRequests).toBe(0);
    expect(initialMessagesRequests).toBe(0);

    context.store.set(reconcileOptimisticChatThreadEvents$, {
      snapshot: [],
      events: [createdEvent],
    });

    await expect(
      context.store.get(dataSource.threadDraft$),
    ).resolves.toStrictEqual({
      draftContent: null,
      draftAttachments: null,
    });
    await expect(
      context.store.set(
        dataSource.listEventsAfter$,
        { threadId: OPTIMISTIC_THREAD_ID, sinceSeqId: undefined },
        context.signal,
      ),
    ).resolves.toStrictEqual({
      events: [],
      hasHistoryBefore: false,
    });
    expect(threadDraftRequests).toBe(1);
    expect(initialMessagesRequests).toBe(1);
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
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
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
    expect(
      context.store.get(
        optimisticChatThreadCreateUnsettled(OPTIMISTIC_THREAD_ID),
      ),
    ).toBeFalsy();
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
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
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
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
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
      openRenameChatThreadDialogFromThreadMeta$,
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
