import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, vi } from "vitest";

import { detachedSetupPage, setupPage } from "../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../signals/__tests__/test-helpers.ts";
import { createChatEventSignals } from "../../signals/chat-page/chat-event-signals.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { writeConnectionDiagnostic$ } from "../../signals/connection-diagnostics.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  upgradeChatIdb,
} from "../../signals/external/chat-idb-schema.ts";
import { openDB } from "idb";
import {
  onSharedDatabase$,
  queryChatEventSharedDatabase$,
  setSharedDatabaseConnectionStatus$,
} from "../../signals/shared-database.ts";
import { selectSharedDatabaseMode$ } from "../../signals/shared-database-mode.ts";
import { okouDebugRealtimeIndicator$ } from "../../signals/okou-page/realtime-status.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const CREATED_AT = "2026-08-14T10:00:00.000Z";

function userId(): string {
  return `direct-bridge-user-${context.resourceId}`;
}

function orgId(): string {
  return `direct-bridge-org-${context.resourceId}`;
}

function realtimeChannel(): string {
  return `user-org:${userId()}:${orgId()}`;
}

function row(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `direct bridge message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

async function seedChatEventCache(cachedRow: ChatEventRow): Promise<void> {
  const db = await openDB(`vm0-chat-${userId()}-${orgId()}`, CHAT_IDB_VERSION, {
    upgrade(database, oldVersion) {
      upgradeChatIdb(database, oldVersion);
    },
  });
  try {
    const tx = db.transaction(
      [CHAT_EVENT_ROWS_STORE, CHAT_EVENT_CURSOR_STORE],
      "readwrite",
    );
    await Promise.all([
      tx.objectStore(CHAT_EVENT_ROWS_STORE).put(cachedRow),
      tx.objectStore(CHAT_EVENT_CURSOR_STORE).put({
        threadId: cachedRow.chatThreadId,
        schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        lastEventId: cachedRow.id,
        lastSeqId: cachedRow.seqId,
        projection: "tool-redacted",
      }),
      tx.done,
    ]);
  } finally {
    db.close();
  }
}

describe("shared database direct Platform bridge", () => {
  it("renders cache first, catches up from its cursor, reacts to append, and prewarms unread", async () => {
    const threadId = crypto.randomUUID();
    const unreadThreadId = crypto.randomUUID();
    const cachedRow = row(threadId, 1);
    const caughtUpRow = row(threadId, 2);
    const realtimeRow = row(threadId, 3);
    await seedChatEventCache(cachedRow);

    const initialPage = context.mocks.deferred<void>();
    let availableRows: readonly ChatEventRow[] = [caughtUpRow];
    const requestedSeqIds: number[] = [];
    const prewarmedThreadIds: string[] = [];
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: {},
        threads: { [unreadThreadId]: "unread" },
      });
    });
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ params, query, respond }) => {
        if (params.threadId === unreadThreadId) {
          prewarmedThreadIds.push(params.threadId);
          return respond(200, chatEventRowsResponse([], query));
        }
        requestedSeqIds.push(query.sinceSeqId);
        if (query.sinceSeqId === 1) {
          await initialPage.promise;
        }
        return respond(
          200,
          chatEventRowsResponse(
            availableRows.filter((candidate) => {
              return candidate.seqId > query.sinceSeqId;
            }),
            query,
          ),
        );
      },
    );

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      org: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
      featureSwitches: { [FeatureSwitchKey.SharedChatDatabase]: true },
    });
    await vi.waitFor(() => {
      expect(prewarmedThreadIds).toContain(unreadThreadId);
    });

    const owner = createChildAbortController(context.signal);
    const signals = createChatEventSignals(threadId);
    await context.store.set(signals.setup$, owner.signal);
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1]);

    const catchUp = context.store.set(signals.catchUp$, owner.signal);
    await vi.waitFor(() => {
      expect(requestedSeqIds).toStrictEqual([1]);
    });
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1]);
    initialPage.resolve(undefined);
    await catchUp;
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1, 2]);

    availableRows = [caughtUpRow, realtimeRow];
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${threadId}`,
    );
    await vi.waitFor(() => {
      expect(
        context.store.get(signals.chatEvents$).map((event) => {
          return event.seqId;
        }),
      ).toStrictEqual([1, 2, 3]);
    });
    expect(requestedSeqIds[0]).toBe(1);
    expect(requestedSeqIds).toContain(2);
    expect(new Set(requestedSeqIds).size).toBe(requestedSeqIds.length);
    expect(
      requestedSeqIds.every((seqId, index) => {
        return index === 0 || seqId > requestedSeqIds[index - 1]!;
      }),
    ).toBeTruthy();

    await expect(
      context.store.set(
        queryChatEventSharedDatabase$,
        {
          dataKey: {
            kind: "chat-event",
            userId: userId(),
            orgId: "another-org",
            threadId,
          },
          afterSeqId: null,
          consistency: "cache-only",
        },
        context.signal,
      ),
    ).rejects.toThrow("does not match client identity");

    owner.abort(new DOMException("chat closed", "AbortError"));
    const requestsBeforeAbort = requestedSeqIds.length;
    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${threadId}`,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(requestedSeqIds).toHaveLength(requestsBeforeAbort);
  });

  it("does not turn a healthy SharedWorker connection red when the tab is hidden", () => {
    context.mocks.browser.visibilityState("hidden");
    context.store.set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: true,
    });
    context.store.set(selectSharedDatabaseMode$, true);
    context.store.set(setSharedDatabaseConnectionStatus$, "connected");

    expect(context.store.get(okouDebugRealtimeIndicator$)).toBeNull();
    context.store.set(setSharedDatabaseConnectionStatus$, "connecting");
    expect(context.store.get(okouDebugRealtimeIndicator$)).toBe("reconnecting");
    context.store.set(setSharedDatabaseConnectionStatus$, "disconnected");
    expect(context.store.get(okouDebugRealtimeIndicator$)).toBe("disconnected");
  });

  it("runs immediate and interval heartbeats through the isolated worker store", async () => {
    const heartbeatGates: {
      readonly promise: Promise<void>;
      readonly resolve: (value: void) => void;
    }[] = [];
    detachedSetupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      org: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
      featureSwitches: { [FeatureSwitchKey.SharedChatDatabase]: true },
      afterSharedDatabaseWorkerHeartbeat: async () => {
        const gate = context.mocks.deferred<void>();
        heartbeatGates.push(gate);
        await gate.promise;
      },
    });

    await vi.waitFor(() => {
      expect(heartbeatGates).toHaveLength(1);
    });
    heartbeatGates[0]?.resolve(undefined);
    await vi.waitFor(() => {
      expect(heartbeatGates).toHaveLength(2);
    });
    heartbeatGates[1]?.resolve(undefined);
    await vi.waitFor(() => {
      expect(heartbeatGates).toHaveLength(3);
    });
    expect(context.store).not.toBe(context.workerStore);
  });

  it("does not recursively invalidate after IndexedDB writes fail", async () => {
    const threadId = crypto.randomUUID();
    const remoteRow = row(threadId, 1);
    const requestedSeqIds: number[] = [];
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, { agents: {}, threads: {} });
    });
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      requestedSeqIds.push(query.sinceSeqId);
      return respond(
        200,
        chatEventRowsResponse(query.sinceSeqId === 0 ? [remoteRow] : [], query),
      );
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      org: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
      featureSwitches: { [FeatureSwitchKey.SharedChatDatabase]: true },
    });

    const owner = createChildAbortController(context.signal);
    const signals = createChatEventSignals(threadId);
    await context.store.set(signals.setup$, owner.signal);
    const dataKey = {
      kind: "chat-event" as const,
      userId: userId(),
      orgId: orgId(),
      threadId,
    };
    let appends = 0;
    await context.store.set(
      onSharedDatabase$,
      dataKey,
      () => {
        appends += 1;
      },
      owner.signal,
    );

    const upgradedDb = await openDB(
      `vm0-chat-${userId()}-${orgId()}`,
      CHAT_IDB_VERSION + 1,
    );
    context.signal.addEventListener("abort", () => {
      upgradedDb.close();
    });

    context.mocks.ably.triggerOnChannel(
      realtimeChannel(),
      `chatThreadMessageCreated:${threadId}`,
    );
    await vi.waitFor(() => {
      expect(
        context.store.get(signals.chatEvents$).map((event) => {
          return event.seqId;
        }),
      ).toStrictEqual([1]);
    });
    expect(appends).toBe(1);
    expect(requestedSeqIds).toStrictEqual([0, 1, 0, 1]);

    await context.store.set(
      queryChatEventSharedDatabase$,
      {
        dataKey,
        afterSeqId: remoteRow.seqId,
        consistency: "catch-up",
      },
      owner.signal,
    );
    expect(appends).toBe(1);
    expect(requestedSeqIds).toStrictEqual([0, 1, 0, 1, 0, 1]);
    owner.abort(new DOMException("chat closed", "AbortError"));
  });

  it("renders and invalidates ChatThreadEvent state through the direct bridge", async () => {
    const threadId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const snapshotEventId = crypto.randomUUID();
    const snapshotThread: ChatThreadSnapshotProjection = {
      id: threadId,
      agentId,
      title: "Snapshot title",
      sortAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      pinnedAt: null,
      renamedAt: null,
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
    };
    const rename = (seqId: number, title: string): ChatThreadEvent => {
      return {
        id: crypto.randomUUID(),
        seqId,
        kind: "renamed",
        chatThreadId: threadId,
        agentId,
        title,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
        createdAt: CREATED_AT,
      };
    };
    const firstRename = rename(2, "First remote title");
    const secondRename = rename(3, "Second remote title");
    let availableEvents: readonly ChatThreadEvent[] = [firstRename];

    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, { agents: {}, threads: {} });
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [snapshotThread],
        latestEventId: snapshotEventId,
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      return respond(200, {
        events: availableEvents.filter((event) => {
          return event.seqId > (query.sinceSeqId ?? 0);
        }),
        hasMore: false,
      });
    });

    await setupPage({
      context,
      path: "/error",
      withoutRender: true,
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      org: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
      featureSwitches: { [FeatureSwitchKey.SharedChatDatabase]: true },
    });
    await vi.waitFor(() => {
      expect(
        context.store.get(eventDrivenChatThreads$).find((thread) => {
          return thread.id === threadId;
        })?.title,
      ).toBe("First remote title");
    });

    availableEvents = [firstRename, secondRename];
    context.mocks.ably.triggerOnChannel(realtimeChannel(), "threadListChanged");
    await vi.waitFor(() => {
      expect(
        context.store.get(eventDrivenChatThreads$).find((thread) => {
          return thread.id === threadId;
        })?.title,
      ).toBe("Second remote title");
    });
  });
});
