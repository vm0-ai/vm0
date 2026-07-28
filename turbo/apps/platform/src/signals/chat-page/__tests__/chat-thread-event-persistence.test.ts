import { toast } from "@vm0/ui/components/ui/sonner";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../../external/chat-idb-schema.ts";
import { chatIdb$, openChatIdb } from "../../external/chat-idb-store.ts";
import { eventDrivenChatThreads$ } from "../chat-thread-event-sourcing.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000901";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const SNAPSHOT_EVENT_ID = "d0000000-0000-4000-a000-000000000900";
const REBASED_SNAPSHOT_EVENT_ID = "d2000000-0000-4000-a000-000000000001";
const POST_SNAPSHOT_EVENT_ID = "d3000000-0000-4000-a000-000000000001";
const SNAPSHOT_SEQ_ID = 1;
const REBASED_SNAPSHOT_SEQ_ID = 2000;
const POST_SNAPSHOT_SEQ_ID = 2001;
const LATEST_CACHED_TITLE = "Title restored from the latest cached event";
const POST_SNAPSHOT_TITLE = "Title from the post-snapshot event";

const snapshotThread = {
  id: THREAD_ID,
  agentId: AGENT_ID,
  title: "Snapshot title",
  sortAt: "2026-07-24T10:00:00.000Z",
  createdAt: "2026-07-24T10:00:00.000Z",
  updatedAt: "2026-07-24T10:00:00.000Z",
  pinnedAt: null,
  renamedAt: null,
  selectedModel: null,
  serviceTier: null,
  computerUseHostId: null,
} satisfies ChatThreadSnapshotProjection;

function createRenamedEvent(
  eventNumber: number,
  title: string,
): ChatThreadEvent {
  return {
    id: `d1000000-0000-4000-a000-${String(eventNumber).padStart(12, "0")}`,
    seqId: eventNumber + SNAPSHOT_SEQ_ID,
    kind: "renamed",
    chatThreadId: THREAD_ID,
    agentId: AGENT_ID,
    title,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    createdAt: new Date(
      Date.parse("2026-07-24T10:00:00.000Z") + eventNumber * 1000,
    ).toISOString(),
  };
}

function createCachedEvents(
  count: number,
  latestTitle = `Cached title ${count}`,
): readonly ChatThreadEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const eventNumber = index + 1;
    return createRenamedEvent(
      eventNumber,
      eventNumber === count ? latestTitle : `Cached title ${eventNumber}`,
    );
  });
}

function createLegacyRenamedEvent(
  eventNumber: number,
  title: string,
): Omit<ChatThreadEvent, "seqId"> {
  const current = createRenamedEvent(eventNumber, title);
  return {
    id: current.id,
    kind: current.kind,
    chatThreadId: current.chatThreadId,
    agentId: current.agentId,
    title: current.title,
    selectedModel: current.selectedModel,
    serviceTier: current.serviceTier,
    computerUseHostId: current.computerUseHostId,
    cloudBrowserEnabled: current.cloudBrowserEnabled,
    createdAt: current.createdAt,
  };
}

async function writeCachedThreadEventLog(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly snapshot: {
    readonly chatThreads: readonly ChatThreadSnapshotProjection[];
    readonly latestEventId: string | null;
    readonly latestSeqId: number | null;
  } | null;
  readonly events: readonly ChatThreadEvent[];
}): Promise<void> {
  const db = await openChatIdb(args.userId, args.orgId);
  try {
    const tx = db.transaction(
      [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
      "readwrite",
    );
    const snapshotStore = tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE);
    const eventStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
    const requests = [
      ...(args.snapshot
        ? [
            snapshotStore.put({
              id: "current",
              chatThreads: [...args.snapshot.chatThreads],
              latestEventId: args.snapshot.latestEventId,
              latestSeqId: args.snapshot.latestSeqId,
            }),
          ]
        : []),
      ...args.events.map((event) => {
        return eventStore.put(event);
      }),
    ];
    await Promise.all([...requests, tx.done]);
  } finally {
    db.close();
  }
}

async function setupAuthenticatedPage(userId: string, orgId: string) {
  await setupPage({
    context,
    path: "/error",
    withoutRender: true,
    user: { id: userId, fullName: "Thread Event Persistence User" },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: orgId, name: "Thread Event Persistence Org" },
      memberships: [{ id: orgId }],
    },
  });
}

describe("chat thread event persistence", () => {
  it("hydrates a paged event log, then rebases it to the remote snapshot", async () => {
    const userId = "thread-event-rebase-user";
    const orgId = "thread-event-rebase-org";
    const cachedEvents = createCachedEvents(1200, LATEST_CACHED_TITLE);
    await writeCachedThreadEventLog({
      userId,
      orgId,
      snapshot: {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: SNAPSHOT_SEQ_ID,
      },
      events: cachedEvents,
    });

    const postSnapshotEvent = {
      ...createRenamedEvent(1201, POST_SNAPSHOT_TITLE),
      id: POST_SNAPSHOT_EVENT_ID,
      seqId: POST_SNAPSHOT_SEQ_ID,
    } satisfies ChatThreadEvent;
    const requestedSeqIds: (number | undefined)[] = [];
    const snapshotGate = context.mocks.deferred<void>();
    let snapshotRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
      snapshotRequests += 1;
      await snapshotGate.promise;
      return respond(200, {
        chatThreads: [{ ...snapshotThread, title: "Rebased snapshot title" }],
        latestEventId: REBASED_SNAPSHOT_EVENT_ID,
        latestSeqId: REBASED_SNAPSHOT_SEQ_ID,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      requestedSeqIds.push(query.sinceSeqId);
      if (query.sinceSeqId === REBASED_SNAPSHOT_SEQ_ID) {
        return respond(200, {
          events: [postSnapshotEvent],
          hasMore: false,
        });
      }
      return respond(200, { events: [], hasMore: false });
    });

    await setupAuthenticatedPage(userId, orgId);

    await vi.waitFor(() => {
      expect(snapshotRequests).toBe(1);
    });
    expect((await context.store.get(eventDrivenChatThreads$))[0]?.title).toBe(
      LATEST_CACHED_TITLE,
    );

    snapshotGate.resolve(undefined);
    const appDb = await context.store.get(chatIdb$);
    try {
      await vi.waitFor(async () => {
        expect(requestedSeqIds).toStrictEqual([
          cachedEvents.at(-1)?.seqId,
          REBASED_SNAPSHOT_SEQ_ID,
        ]);
        expect(
          (await context.store.get(eventDrivenChatThreads$))[0]?.title,
        ).toBe(POST_SNAPSHOT_TITLE);

        const tx = appDb.transaction(
          [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
          "readonly",
        );
        const [storedSnapshot, storedEvents] = await Promise.all([
          tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).get("current"),
          tx.objectStore(CHAT_THREAD_EVENTS_STORE).getAll(),
          tx.done,
        ]);
        expect(storedSnapshot).toMatchObject({
          latestEventId: REBASED_SNAPSHOT_EVENT_ID,
          latestSeqId: REBASED_SNAPSHOT_SEQ_ID,
        });
        expect(storedEvents).toStrictEqual([postSnapshotEvent]);
      });
    } finally {
      appDb.close();
    }
  });

  it("does not rebase when the first sync leaves exactly 100 events", async () => {
    const userId = "thread-event-threshold-user";
    const orgId = "thread-event-threshold-org";
    const cachedEvents = createCachedEvents(99);
    const hundredthEvent = createRenamedEvent(100, "Hundredth event title");
    await writeCachedThreadEventLog({
      userId,
      orgId,
      snapshot: {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: SNAPSHOT_SEQ_ID,
      },
      events: cachedEvents,
    });

    let snapshotRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: SNAPSHOT_SEQ_ID,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [hundredthEvent], hasMore: false });
    });

    await setupAuthenticatedPage(userId, orgId);

    const appDb = await context.store.get(chatIdb$);
    try {
      await vi.waitFor(async () => {
        expect(
          (await context.store.get(eventDrivenChatThreads$))[0]?.title,
        ).toBe("Hundredth event title");
        await expect(
          appDb.transaction(CHAT_THREAD_EVENTS_STORE, "readonly").store.count(),
        ).resolves.toBe(100);
      });
      expect(snapshotRequests).toBe(0);
    } finally {
      appDb.close();
    }
  });

  it("does not pull a second snapshot when the first sync replaced it", async () => {
    const userId = "thread-event-initial-snapshot-user";
    const orgId = "thread-event-initial-snapshot-org";
    const remoteEvents = createCachedEvents(101, "Latest remote title");
    await writeCachedThreadEventLog({
      userId,
      orgId,
      snapshot: null,
      events: [],
    });

    let snapshotRequests = 0;
    let eventRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: SNAPSHOT_SEQ_ID,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      eventRequests += 1;
      return respond(200, {
        events: query.sinceSeqId === SNAPSHOT_SEQ_ID ? [...remoteEvents] : [],
        hasMore: false,
      });
    });

    await setupAuthenticatedPage(userId, orgId);

    await vi.waitFor(async () => {
      expect((await context.store.get(eventDrivenChatThreads$))[0]?.title).toBe(
        "Latest remote title",
      );
    });
    context.mocks.ably.trigger("threadListChanged");
    await vi.waitFor(() => {
      expect(eventRequests).toBe(2);
    });
    expect(snapshotRequests).toBe(1);
  });

  it("silently skips a failed rebase for the rest of the session", async () => {
    const userId = "thread-event-failed-rebase-user";
    const orgId = "thread-event-failed-rebase-org";
    const cachedEvents = createCachedEvents(101);
    await writeCachedThreadEventLog({
      userId,
      orgId,
      snapshot: {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: SNAPSHOT_SEQ_ID,
      },
      events: cachedEvents,
    });

    const errorToast = vi.spyOn(toast, "error");
    context.signal.addEventListener("abort", () => {
      errorToast.mockRestore();
    });
    let snapshotRequests = 0;
    let eventRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(403, {
        error: { message: "Snapshot unavailable", code: "FORBIDDEN" },
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      eventRequests += 1;
      return respond(200, { events: [], hasMore: false });
    });

    await setupAuthenticatedPage(userId, orgId);

    await vi.waitFor(() => {
      expect(snapshotRequests).toBe(1);
    });
    context.mocks.ably.trigger("threadListChanged");
    await vi.waitFor(() => {
      expect(eventRequests).toBe(2);
    });
    expect(snapshotRequests).toBe(1);
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("pages with UUID cursors while the new app is paired with the old API", async () => {
    const userId = "thread-event-old-api-user";
    const orgId = "thread-event-old-api-org";
    const firstEvent = createLegacyRenamedEvent(1, "First legacy page");
    const secondEvent = createLegacyRenamedEvent(2, "Second legacy page");
    const promotedEvent = createRenamedEvent(3, "Post-promotion page");
    const requestedCursors: {
      readonly eventId: string | null;
      readonly seqId: string | null;
    }[] = [];
    context.mocks.http.get("/api/zero/chat-threads/snapshot", () => {
      return HttpResponse.json({
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
      });
    });
    context.mocks.http.get("/api/zero/chat-threads/events", ({ request }) => {
      const url = new URL(request.url);
      const eventId = url.searchParams.get("sinceEventId");
      requestedCursors.push({
        eventId,
        seqId: url.searchParams.get("sinceSeqId"),
      });
      if (eventId === SNAPSHOT_EVENT_ID) {
        return HttpResponse.json({ events: [firstEvent], hasMore: true });
      }
      if (eventId === firstEvent.id) {
        return HttpResponse.json({ events: [secondEvent], hasMore: true });
      }
      if (eventId === secondEvent.id) {
        return HttpResponse.json({ events: [promotedEvent], hasMore: false });
      }
      return HttpResponse.json({ events: [], hasMore: false });
    });

    await setupAuthenticatedPage(userId, orgId);

    await vi.waitFor(async () => {
      expect((await context.store.get(eventDrivenChatThreads$))[0]?.title).toBe(
        "Post-promotion page",
      );
    });
    expect(requestedCursors).toStrictEqual([
      { eventId: SNAPSHOT_EVENT_ID, seqId: null },
      { eventId: firstEvent.id, seqId: null },
      { eventId: secondEvent.id, seqId: null },
    ]);

    const appDb = await context.store.get(chatIdb$);
    try {
      const tx = appDb.transaction(
        [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
        "readonly",
      );
      const [storedSnapshot, storedEvents] = await Promise.all([
        tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).get("current"),
        tx.objectStore(CHAT_THREAD_EVENTS_STORE).getAll(),
        tx.done,
      ]);
      expect(storedSnapshot).toMatchObject({
        latestEventId: SNAPSHOT_EVENT_ID,
        latestSeqId: null,
      });
      expect(storedEvents).toStrictEqual([]);
    } finally {
      appDb.close();
    }
  });
});
