import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { chatThreads$, setChatAgentId$ } from "../../agent-chat.ts";

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
  const replaceFromSnapshot = vi.fn(() => {
    return Promise.resolve();
  });
  const upsertEvents = vi.fn(() => {
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
const EVENT_ID = "d0000000-0000-4000-a000-000000000001";

function expectCallback(callback: (() => void) | null): () => void {
  expect(callback).not.toBeNull();
  if (!callback) {
    throw new Error("Expected callback to be set");
  }
  return callback;
}

describe("chat thread event sourcing local-first list", () => {
  afterEach(() => {
    idbThreadEventStoreMock.reset();
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
    let listRequests = 0;
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
    context.mocks.api(chatThreadsContract.list, ({ never }) => {
      listRequests += 1;
      return never();
    });
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
      featureSwitches: { [FeatureSwitchKey.ChatThreadEventSourcing]: true },
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
    expect(listRequests).toBe(0);
    expect(teamRequests).toBe(0);
    expectCallback(unblockEventsRequest)();
  });
});
