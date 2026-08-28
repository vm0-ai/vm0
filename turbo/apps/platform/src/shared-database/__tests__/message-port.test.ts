import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { Store } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../lib/time.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import {
  heartbeatSharedDatabase$,
  installSharedDatabaseBridge$,
  queryChatEventSharedDatabase$,
} from "../../signals/shared-database.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabasePortLike,
} from "../bridge.ts";
import type { ChatEventDataKey, SharedDatabaseIdentity } from "../data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "../message-port-server.ts";
import { ReconnectingSharedDatabaseBridge } from "../reconnecting-client.ts";
import type {
  SharedDatabaseClientMessage,
  SharedDatabaseConnectionStatus,
} from "../protocol.ts";
import { bootstrapSharedDatabaseWorker$ } from "../worker-signals.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();
const CREATED_AT = "2026-08-14T09:00:00.000Z";

class InMemoryMessagePort implements SharedDatabasePortLike {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  peer: InMemoryMessagePort | null = null;
  closed = false;

  postMessage(value: unknown): void {
    if (this.closed) {
      return;
    }
    const cloned: unknown = structuredClone(value);
    queueMicrotask(() => {
      this.peer?.dispatch(cloned);
    });
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  private dispatch(data: unknown): void {
    if (this.closed) {
      return;
    }
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

function messagePortPair(): readonly [
  InMemoryMessagePort,
  InMemoryMessagePort,
] {
  const platformPort = new InMemoryMessagePort();
  const workerPort = new InMemoryMessagePort();
  platformPort.peer = workerPort;
  workerPort.peer = platformPort;
  return [platformPort, workerPort];
}

function identity(): SharedDatabaseIdentity {
  return {
    userId: `message-port-user-${context.resourceId}`,
    orgId: `message-port-org-${context.resourceId}`,
    token: "message-port-token",
  };
}

function heartbeat(vercelProtectionBypass?: string): SharedDatabaseHeartbeat {
  return {
    identity: identity(),
    ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
  };
}

function dataKey(threadId: string): ChatEventDataKey {
  const current = identity();
  return {
    kind: "chat-event",
    userId: current.userId,
    orgId: current.orgId,
    threadId,
  };
}

function row(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `port message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

function installProtocolBridge(): {
  readonly platformStore: Store;
  readonly workerStore: Store;
  readonly platformPort: InMemoryMessagePort;
  readonly workerPort: InMemoryMessagePort;
} {
  const platformStore = context.store;
  const workerStore = context.workerStore;
  const [platformPort, workerPort] = messagePortPair();
  workerStore.set(bootstrapSharedDatabaseWorker$, context.signal);
  new SharedDatabaseMessagePortServer(workerStore, workerPort, context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    {
      reloadRequired: vi.fn<() => void>(),
      statusChanged: vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
    },
  );
  platformStore.set(installSharedDatabaseBridge$, bridge);
  return { platformStore, workerStore, platformPort, workerPort };
}

describe("shared database MessagePort protocol", () => {
  it("correlates out-of-order queries across structured-cloned independent stores", async () => {
    const { platformStore, workerStore } = installProtocolBridge();
    expect(platformStore).not.toBe(workerStore);
    await platformStore.set(
      heartbeatSharedDatabase$,
      heartbeat(),
      context.signal,
    );

    const firstKey = dataKey(crypto.randomUUID());
    const secondKey = dataKey(crypto.randomUUID());
    const firstRow = row(firstKey.threadId, 1);
    const secondRow = row(secondKey.threadId, 1);
    const firstGate = context.mocks.deferred<void>();
    const secondGate = context.mocks.deferred<void>();
    const started = new Set<string>();

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
        if (query.sinceSeqId > 0) {
          return respond(200, { rows: [] });
        }
        started.add(params.threadId);
        if (params.threadId === firstKey.threadId) {
          await firstGate.promise;
          return respond(200, { rows: [firstRow] });
        }
        await secondGate.promise;
        return respond(200, { rows: [secondRow] });
      },
    );

    const first = platformStore.set(
      queryChatEventSharedDatabase$,
      {
        dataKey: firstKey,
        afterSeqId: null,
        consistency: "catch-up",
      },
      context.signal,
    );
    const second = platformStore.set(
      queryChatEventSharedDatabase$,
      {
        dataKey: secondKey,
        afterSeqId: null,
        consistency: "catch-up",
      },
      context.signal,
    );
    await vi.waitFor(() => {
      expect(started).toStrictEqual(
        new Set([firstKey.threadId, secondKey.threadId]),
      );
    });

    secondGate.resolve(undefined);
    await expect(second).resolves.toStrictEqual([secondRow]);
    firstGate.resolve(undefined);
    await expect(first).resolves.toStrictEqual([firstRow]);
  });

  it("cancels one RPC wait without cancelling worker-owned catch-up", async () => {
    const { platformStore } = installProtocolBridge();
    await platformStore.set(
      heartbeatSharedDatabase$,
      heartbeat(),
      context.signal,
    );
    const key = dataKey(crypto.randomUUID());
    const canonicalRow = row(key.threadId, 1);
    const pageGate = context.mocks.deferred<void>();
    let pageStarted = false;

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
      async ({ query, respond }) => {
        if (query.sinceSeqId === 0) {
          pageStarted = true;
          await pageGate.promise;
          return respond(200, { rows: [canonicalRow] });
        }
        return respond(200, { rows: [] });
      },
    );

    const caller = createChildAbortController(context.signal);
    const pending = platformStore.set(
      queryChatEventSharedDatabase$,
      { dataKey: key, afterSeqId: null, consistency: "catch-up" },
      caller.signal,
    );
    await vi.waitFor(() => {
      expect(pageStarted).toBeTruthy();
    });
    caller.abort(new DOMException("tab query cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    pageGate.resolve(undefined);

    await vi.waitFor(async () => {
      await expect(
        platformStore.set(
          queryChatEventSharedDatabase$,
          { dataKey: key, afterSeqId: null, consistency: "cache-only" },
          context.signal,
        ),
      ).resolves.toStrictEqual([canonicalRow]);
    });
  });

  it("reconnects a stale pruned tab and restores its subscription", async () => {
    const workerStore = context.workerStore;
    workerStore.set(bootstrapSharedDatabaseWorker$, context.signal);
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(start, context.signal);
    const connectProtocolTransport = (
      events: SharedDatabaseBridgeEvents,
    ): MessagePortSharedDatabaseBridge => {
      const [platformPort, workerPort] = messagePortPair();
      new SharedDatabaseMessagePortServer(
        workerStore,
        workerPort,
        context.signal,
      );
      return new MessagePortSharedDatabaseBridge(
        platformPort,
        location.origin,
        events,
      );
    };

    let firstTabTransports = 0;
    let staleTabTransports = 0;
    const staleTabStatuses: SharedDatabaseConnectionStatus[] = [];
    const firstTab = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        firstTabTransports += 1;
        return connectProtocolTransport(events);
      },
      events: {
        reloadRequired: vi.fn<() => void>(),
        statusChanged:
          vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
      },
    });
    const staleTab = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        staleTabTransports += 1;
        return connectProtocolTransport(events);
      },
      events: {
        reloadRequired: vi.fn<() => void>(),
        statusChanged: (status) => {
          staleTabStatuses.push(status);
        },
      },
    });
    const firstOwner = createChildAbortController(context.signal);
    const staleOwner = createChildAbortController(context.signal);
    const subscription = createChildAbortController(context.signal);
    try {
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);
      await staleTab.heartbeat(heartbeat(), staleOwner.signal);

      const key = dataKey(crypto.randomUUID());
      const canonicalRow = row(key.threadId, 1);
      const requestedSeqIds: number[] = [];
      let appends = 0;
      const initialAttach = context.mocks.ably.deferNextSubscribe();
      await staleTab.on(
        key,
        () => {
          appends += 1;
        },
        subscription.signal,
      );
      await initialAttach.started;
      await vi.waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
        expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
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
        return respond(200, {
          rows: query.sinceSeqId === 0 ? [canonicalRow] : [],
        });
      });

      mockNow(start + 2 * 60 * 1000, context.signal);
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);
      mockNow(start + 4 * 60 * 1000, context.signal);
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);

      expect(firstTabTransports).toBe(1);
      expect(staleTabTransports).toBe(1);
      expect(context.mocks.ably.hasChannelSubscription()).toBeFalsy();
      initialAttach.attach();
      const recoveredAttach = context.mocks.ably.deferNextSubscribe();
      await staleTab.heartbeat(heartbeat(), staleOwner.signal);
      await recoveredAttach.started;
      expect(staleTabTransports).toBe(1);
      recoveredAttach.attach();
      await vi.waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
        expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
        expect(staleTabStatuses.at(-1)).toBe("connected");
        expect(requestedSeqIds).toStrictEqual([0, 1]);
        expect(appends).toBe(1);
      });
    } finally {
      subscription.abort();
      staleOwner.abort();
      firstOwner.abort();
    }
  });

  it("validates results and handles callback cleanup plus control messages", async () => {
    const [platformPort, serverPort] = messagePortPair();
    const statuses: SharedDatabaseConnectionStatus[] = [];
    let reloads = 0;
    let subscriptionId: string | null = null;
    let observedHeartbeat: SharedDatabaseClientMessage | null = null;
    let unsubscribeObserved = false;
    const key = dataKey(crypto.randomUUID());
    const bridge = new MessagePortSharedDatabaseBridge(
      platformPort,
      location.origin,
      {
        reloadRequired: () => {
          reloads += 1;
        },
        statusChanged: (status) => {
          statuses.push(status);
        },
      },
    );
    serverPort.addEventListener("message", (event) => {
      const message = event.data as SharedDatabaseClientMessage;
      if (message.type === "heartbeat") {
        observedHeartbeat = message;
        serverPort.postMessage({
          type: "result",
          requestId: message.requestId,
          value: { clientReconnected: false },
        });
        return;
      }
      if (message.type === "subscribe") {
        subscriptionId = message.subscriptionId;
        serverPort.postMessage({
          type: "append",
          subscriptionId: message.subscriptionId,
          dataKey: key,
        });
        serverPort.postMessage({
          type: "result",
          requestId: message.requestId,
          value: null,
        });
        return;
      }
      if (message.type === "unsubscribe") {
        unsubscribeObserved = true;
        return;
      }
      if (message.type === "query") {
        serverPort.postMessage({
          type: "result",
          requestId: message.requestId,
          value: [{ malformed: true }],
        });
      }
    });
    serverPort.start();

    const owner = createChildAbortController(context.signal);
    await bridge.heartbeat(heartbeat("preview-secret"), owner.signal);
    expect(observedHeartbeat).toMatchObject({
      type: "heartbeat",
      identity: identity(),
      apiBaseUrl: location.origin,
      vercelProtectionBypass: "preview-secret",
    });

    const subscription = createChildAbortController(context.signal);
    let callbacks = 0;
    await bridge.on(
      key,
      () => {
        callbacks += 1;
      },
      subscription.signal,
    );
    expect(callbacks).toBe(1);
    expect(subscriptionId).not.toBeNull();

    subscription.abort(new DOMException("listener removed", "AbortError"));
    await vi.waitFor(() => {
      expect(unsubscribeObserved).toBeTruthy();
    });
    if (subscriptionId === null) {
      throw new Error("Expected a protocol subscription ID");
    }
    serverPort.postMessage({
      type: "append",
      subscriptionId,
      dataKey: key,
    });
    await Promise.resolve();
    expect(callbacks).toBe(1);

    await expect(
      bridge.query(
        { dataKey: key, afterSeqId: null, consistency: "cache-only" },
        owner.signal,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });

    serverPort.postMessage({ type: "status", status: "disconnected" });
    serverPort.postMessage({ type: "reload-required" });
    await vi.waitFor(() => {
      expect(statuses).toStrictEqual(["disconnected"]);
      expect(reloads).toBe(1);
    });
  });

  it("disconnects a worker port immediately on malformed input", async () => {
    const workerStore = context.workerStore;
    const [platformPort, workerPort] = messagePortPair();
    workerStore.set(bootstrapSharedDatabaseWorker$, context.signal);
    new SharedDatabaseMessagePortServer(
      workerStore,
      workerPort,
      context.signal,
    );

    platformPort.postMessage({
      type: "query",
      requestId: crypto.randomUUID(),
      query: { consistency: "cache-only" },
    });

    await vi.waitFor(() => {
      expect(workerPort.closed).toBeTruthy();
    });
  });
});
