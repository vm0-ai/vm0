import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Store } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import {
  testContext,
  chatEventRowsResponse,
} from "../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../lib/time.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import {
  heartbeatSharedDatabase$,
  installSharedDatabaseBridge$,
  queryChatEventSharedDatabase$,
  sharedDatabaseChatThreadIndicators$,
} from "../../signals/shared-database.ts";
import { reloadChatIndicators$ } from "../../signals/chat-thread-list-reload.ts";
import { setRootSignal$ } from "../../signals/root-signal.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabasePortLike,
} from "../bridge.ts";
import type { ChatEventDataKey, SharedDatabaseIdentity } from "../data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import {
  SharedDatabaseMessagePortServer,
  type SharedDatabaseWorkerMaps,
} from "../message-port-server.ts";
import { ReconnectingSharedDatabaseBridge } from "../reconnecting-client.ts";
import type {
  SharedDatabaseClientMessage,
  SharedDatabaseConnectionStatus,
} from "../protocol.ts";

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
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.listeners.add(listener);
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        this.listeners.delete(listener);
      },
      { once: true },
    );
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
    token: identity().token,
    ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
  };
}

function dataKey(threadId: string): ChatEventDataKey {
  return {
    kind: "chat-event",
    threadId,
  };
}

function workerBoundaryState(): SharedDatabaseWorkerMaps {
  return {
    credentialStores: new Map(),
    credentialAbortControllers: new Map(),
    tabCredentialIds: new Map(),
    tabHeartbeatAts: new Map(),
  };
}

function installHeartbeatAuthentication(): void {
  const current = identity();
  context.mocks.api(authContract.me, ({ respond }) => {
    return respond(200, {
      userId: current.userId,
      email: "message-port@example.com",
      orgId: current.orgId,
    });
  });
}

function installMessagePortServer(
  workerPort: InMemoryMessagePort,
  boundary: SharedDatabaseWorkerMaps,
): void {
  new SharedDatabaseMessagePortServer(workerPort, context.signal, boundary);
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
  readonly boundary: SharedDatabaseWorkerMaps;
  readonly platformPort: InMemoryMessagePort;
  readonly workerPort: InMemoryMessagePort;
} {
  const platformStore = context.store;
  platformStore.set(setRootSignal$, context.signal);
  const boundary = workerBoundaryState();
  const [platformPort, workerPort] = messagePortPair();
  installHeartbeatAuthentication();
  installMessagePortServer(workerPort, boundary);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    {
      authenticationRequired: vi.fn<() => void>(),
      indicatorsInvalidated: () => {
        platformStore.set(reloadChatIndicators$);
      },
      reloadRequired: vi.fn<() => void>(),
      statusChanged: vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
    },
  );
  platformStore.set(installSharedDatabaseBridge$, bridge);
  return { platformStore, boundary, platformPort, workerPort };
}

function connectProtocolTransport(
  events: SharedDatabaseBridgeEvents,
  boundary: SharedDatabaseWorkerMaps,
): MessagePortSharedDatabaseBridge {
  const [platformPort, workerPort] = messagePortPair();
  installMessagePortServer(workerPort, boundary);
  return new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    events,
  );
}

describe("shared database MessagePort protocol", () => {
  it("shares one credential Store and fans indicator invalidation to every tab", async () => {
    installHeartbeatAuthentication();
    const boundary = workerBoundaryState();
    const firstInvalidated = vi.fn<() => void>();
    const secondInvalidated = vi.fn<() => void>();
    const createEvents = (
      indicatorsInvalidated: () => void,
    ): SharedDatabaseBridgeEvents => {
      return {
        authenticationRequired: vi.fn<() => void>(),
        indicatorsInvalidated,
        reloadRequired: vi.fn<() => void>(),
        statusChanged:
          vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
      };
    };
    const first = connectProtocolTransport(
      createEvents(firstInvalidated),
      boundary,
    );
    const second = connectProtocolTransport(
      createEvents(secondInvalidated),
      boundary,
    );

    await first.heartbeat(heartbeat(), context.signal);
    await second.heartbeat(heartbeat(), context.signal);
    expect(boundary.credentialStores.size).toBe(1);
    expect(boundary.credentialAbortControllers.size).toBe(1);
    expect(boundary.tabCredentialIds.size).toBe(2);
    await expect(
      first.query(
        {
          dataKey: dataKey(crypto.randomUUID()),
          afterSeqId: null,
          consistency: "cache-only",
        },
        context.signal,
      ),
    ).resolves.toStrictEqual([]);
    await vi.waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
    });

    context.mocks.ably.trigger("threadListChanged");

    await vi.waitFor(() => {
      expect(firstInvalidated).toHaveBeenCalledOnce();
      expect(secondInvalidated).toHaveBeenCalledOnce();
    });
  });

  it("reads and refreshes the worker-owned indicator computed", async () => {
    const { platformStore } = installProtocolBridge();
    const threadId = crypto.randomUUID();
    let requests = 0;
    let indicators: {
      agents: Record<string, "active" | "unread">;
      threads: Record<string, "active" | "unread">;
    } = { agents: {}, threads: {} };
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      requests += 1;
      return respond(200, indicators);
    });
    await platformStore.set(
      heartbeatSharedDatabase$,
      heartbeat(),
      context.signal,
    );
    await vi.waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("threadListChanged"),
      ).toBeTruthy();
    });

    await expect(
      platformStore.get(sharedDatabaseChatThreadIndicators$),
    ).resolves.toStrictEqual({ agents: {}, threads: {} });
    expect(requests).toBe(1);

    indicators = {
      agents: {},
      threads: { [threadId]: "unread" },
    };
    context.mocks.ably.trigger("threadListChanged");

    await vi.waitFor(async () => {
      await expect(
        platformStore.get(sharedDatabaseChatThreadIndicators$),
      ).resolves.toStrictEqual(indicators);
      expect(requests).toBe(2);
    });
  });

  it("correlates out-of-order queries across structured-cloned independent stores", async () => {
    const { platformStore, boundary } = installProtocolBridge();
    await platformStore.set(
      heartbeatSharedDatabase$,
      heartbeat(),
      context.signal,
    );
    expect(boundary.credentialStores.size).toBe(1);
    expect(platformStore).not.toBe(
      Array.from(boundary.credentialStores.values())[0],
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
          return respond(200, chatEventRowsResponse([], query));
        }
        started.add(params.threadId);
        if (params.threadId === firstKey.threadId) {
          await firstGate.promise;
          return respond(200, chatEventRowsResponse([firstRow], query));
        }
        await secondGate.promise;
        return respond(200, chatEventRowsResponse([secondRow], query));
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
          return respond(200, chatEventRowsResponse([canonicalRow], query));
        }
        return respond(200, chatEventRowsResponse([], query));
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
    installHeartbeatAuthentication();
    const boundary = workerBoundaryState();
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(start, context.signal);

    let firstTabTransports = 0;
    let staleTabTransports = 0;
    const staleTabStatuses: SharedDatabaseConnectionStatus[] = [];
    const firstTab = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        firstTabTransports += 1;
        return connectProtocolTransport(events, boundary);
      },
      events: {
        authenticationRequired: vi.fn<() => void>(),
        indicatorsInvalidated: vi.fn<() => void>(),
        reloadRequired: vi.fn<() => void>(),
        statusChanged:
          vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
      },
    });
    const staleTab = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        staleTabTransports += 1;
        return connectProtocolTransport(events, boundary);
      },
      events: {
        authenticationRequired: vi.fn<() => void>(),
        indicatorsInvalidated: vi.fn<() => void>(),
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
      const initialAttach = context.mocks.ably.deferNextSubscribe();
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);
      await staleTab.heartbeat(heartbeat(), staleOwner.signal);

      const key = dataKey(crypto.randomUUID());
      const canonicalRow = row(key.threadId, 1);
      const requestedSeqIds: number[] = [];
      let appends = 0;
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
        expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
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
          chatEventRowsResponse(
            query.sinceSeqId === 0 ? [canonicalRow] : [],
            query,
          ),
        );
      });

      mockNow(start + 2 * 60 * 1000, context.signal);
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);
      mockNow(start + 4 * 60 * 1000, context.signal);
      await firstTab.heartbeat(heartbeat(), firstOwner.signal);

      expect(firstTabTransports).toBe(1);
      expect(staleTabTransports).toBe(1);
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      initialAttach.attach();
      await staleTab.heartbeat(heartbeat(), staleOwner.signal);
      expect(staleTabTransports).toBe(1);
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

  it("renews a single expired tab over its existing MessagePort", async () => {
    installHeartbeatAuthentication();
    const boundary = workerBoundaryState();
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(start, context.signal);
    let transports = 0;
    const bridge = new ReconnectingSharedDatabaseBridge({
      createBridge: (events) => {
        transports += 1;
        return connectProtocolTransport(events, boundary);
      },
      events: {
        authenticationRequired: vi.fn<() => void>(),
        indicatorsInvalidated: vi.fn<() => void>(),
        reloadRequired: vi.fn<() => void>(),
        statusChanged:
          vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
      },
    });
    const owner = createChildAbortController(context.signal);
    const subscription = createChildAbortController(context.signal);
    try {
      const initialAttach = context.mocks.ably.deferNextSubscribe();
      await bridge.heartbeat(heartbeat(), owner.signal);
      const key = dataKey(crypto.randomUUID());
      context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
        return respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "Chat event snapshot not found",
          },
        });
      });
      context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
        return respond(200, chatEventRowsResponse([], query));
      });

      await bridge.on(key, vi.fn<() => void>(), subscription.signal);
      await initialAttach.started;
      initialAttach.attach();
      await vi.waitFor(() => {
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
        expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
      });
      const initialController = Array.from(
        boundary.credentialAbortControllers.values(),
      )[0];
      if (!initialController) {
        throw new Error("Expected a credential Store AbortController");
      }

      mockNow(start + 4 * 60 * 1000, context.signal);
      const renewedAttach = context.mocks.ably.deferNextSubscribe();
      await bridge.heartbeat(heartbeat(), owner.signal);
      await renewedAttach.started;
      renewedAttach.attach();
      await vi.waitFor(() => {
        expect(transports).toBe(1);
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
        expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(4);
      });
      expect(initialController.signal.aborted).toBeTruthy();
      expect(
        Array.from(boundary.credentialAbortControllers.values())[0],
      ).not.toBe(initialController);
    } finally {
      subscription.abort();
      owner.abort();
    }
  });

  it("validates results and handles callback cleanup plus control messages", async () => {
    const [platformPort, serverPort] = messagePortPair();
    const statuses: SharedDatabaseConnectionStatus[] = [];
    let authenticationRequests = 0;
    let indicatorInvalidations = 0;
    let reloads = 0;
    let subscriptionId: string | null = null;
    let observedHeartbeat: SharedDatabaseClientMessage | null = null;
    let unsubscribeObserved = false;
    const key = dataKey(crypto.randomUUID());
    const bridge = new MessagePortSharedDatabaseBridge(
      platformPort,
      location.origin,
      {
        authenticationRequired: () => {
          authenticationRequests += 1;
        },
        indicatorsInvalidated: () => {
          indicatorInvalidations += 1;
        },
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
      token: identity().token,
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

    serverPort.postMessage({ type: "authentication-required" });
    serverPort.postMessage({ type: "indicators-invalidated" });
    serverPort.postMessage({ type: "status", status: "disconnected" });
    serverPort.postMessage({ type: "reload-required" });
    await vi.waitFor(() => {
      expect(statuses).toStrictEqual(["disconnected"]);
      expect(authenticationRequests).toBe(1);
      expect(indicatorInvalidations).toBe(1);
      expect(reloads).toBe(1);
    });
  });

  it("disconnects a worker port immediately on malformed input", async () => {
    const [platformPort, workerPort] = messagePortPair();
    installMessagePortServer(workerPort, workerBoundaryState());

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
