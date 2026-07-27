import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
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

const USER_ID = "thread-event-persistence-user";
const ORG_ID = "thread-event-persistence-org";
const AGENT_ID = "c0000000-0000-4000-a000-000000000901";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const SNAPSHOT_EVENT_ID = "d0000000-0000-4000-a000-000000000900";
const EVENT_COUNT = 1200;
const LATEST_TITLE = "Title restored from the latest cached event";

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

const cachedEvents = Array.from({ length: EVENT_COUNT }, (_, index) => {
  const eventNumber = index + 1;
  return {
    id: `d1000000-0000-4000-a000-${String(eventNumber).padStart(12, "0")}`,
    kind: "renamed",
    chatThreadId: THREAD_ID,
    agentId: AGENT_ID,
    title:
      eventNumber === EVENT_COUNT
        ? LATEST_TITLE
        : `Cached title ${eventNumber}`,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    createdAt: new Date(
      Date.parse("2026-07-24T10:00:00.000Z") + eventNumber * 1000,
    ).toISOString(),
  } satisfies ChatThreadEvent;
});

async function seedCachedThreadEventLog(): Promise<void> {
  const db = await openChatIdb(USER_ID, ORG_ID);
  try {
    const tx = db.transaction(
      [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
      "readwrite",
    );
    const snapshotStore = tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE);
    const eventStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
    const requests = [
      snapshotStore.put({
        id: "current",
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
      }),
      ...cachedEvents.map((event) => {
        return eventStore.put(event);
      }),
    ];
    await Promise.all([...requests, tx.done]);
  } finally {
    db.close();
  }
}

describe("chat thread event persistence", () => {
  it("hydrates a cached event log across read pages and resumes from its latest event", async () => {
    await seedCachedThreadEventLog();

    const requestedEventIds: (string | undefined)[] = [];
    let snapshotRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [snapshotThread],
        latestEventId: SNAPSHOT_EVENT_ID,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      requestedEventIds.push(query.sinceEventId);
      return respond(200, { events: [], hasMore: false });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: USER_ID, fullName: "Thread Event Persistence User" },
      session: { token: "test-token" },
      org: {
        activeOrg: { id: ORG_ID, name: "Thread Event Persistence Org" },
        memberships: [{ id: ORG_ID }],
      },
    });

    const appDb = await context.store.get(chatIdb$);
    try {
      await vi.waitFor(async () => {
        expect(requestedEventIds[0]).toBe(cachedEvents.at(-1)?.id);
        expect(
          (await context.store.get(eventDrivenChatThreads$))[0]?.title,
        ).toBe(LATEST_TITLE);
      });
      expect(snapshotRequests).toBe(0);
    } finally {
      appDb.close();
    }
  });
});
