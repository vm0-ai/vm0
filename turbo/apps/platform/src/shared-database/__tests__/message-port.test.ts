import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

import {
  chatEventRowsResponse,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import { mockNow } from "../../lib/time.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "../bridge.ts";
import type { ComputedKey } from "../computed-key.ts";
import type {
  ChatEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "../message-port-server.ts";
import type { SharedDatabaseConnectionStatus } from "../protocol.ts";
import {
  registerConnection$,
  requestTokenFromFirstConnection$,
} from "../worker-context.ts";
import {
  getComputedStoreMessage$,
  initializeSharedDatabaseWorker$,
  refreshWorkerComputed$,
} from "../worker-signals.ts";

const context = testContext();
const CREATED_AT = "2026-08-14T09:00:00.000Z";
const WORKER_APP_VERSION = "message-port-worker-version";

class InMemoryMessagePort implements SharedDatabasePortLike {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly postedMessages: unknown[] = [];
  peer: InMemoryMessagePort | null = null;
  closed = false;

  postMessage(value: unknown): void {
    if (this.closed) {
      return;
    }
    const cloned: unknown = structuredClone(value);
    this.postedMessages.push(cloned);
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
      listener(new MessageEvent("message", { data }));
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
  };
}

function dataKey(threadId: string): ChatEventDataKey {
  return {
    kind: "chat-event",
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

function bridgeEvents(): SharedDatabaseBridgeEvents {
  return {
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    databaseReconnected: vi.fn<() => void>(),
    workerUnavailable: vi.fn<SharedDatabaseBridgeEvents["workerUnavailable"]>(),
    statusChanged: vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
  };
}

function initializeWorker(signal: AbortSignal = context.signal): void {
  const workerIdentity = identity();
  context.workerStore.set(
    initializeSharedDatabaseWorker$,
    {
      appVersion: WORKER_APP_VERSION,
      identity: workerIdentity,
      apiBaseUrl: location.origin,
      getToken: (signal) => {
        return context.workerStore.set(
          requestTokenFromFirstConnection$,
          signal,
        );
      },
      oauthApiBaseUrl: location.origin,
      onForceUpgrade: vi.fn<() => void>(),
    },
    signal,
  );
}

function connectProtocolTransport(
  bridgeSignal: AbortSignal,
  getToken: SharedDatabaseTokenProvider = () => {
    return Promise.resolve("message-port-token");
  },
  events: SharedDatabaseBridgeEvents = bridgeEvents(),
): {
  readonly bridge: MessagePortSharedDatabaseBridge;
  readonly platformPort: InMemoryMessagePort;
  readonly workerPort: InMemoryMessagePort;
} {
  const [platformPort, workerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    context.workerStore,
    workerPort,
    context.signal,
  );
  return {
    bridge: new MessagePortSharedDatabaseBridge(
      platformPort,
      events,
      bridgeSignal,
      getToken,
    ),
    platformPort,
    workerPort,
  };
}

test("Keep concurrent shared chat loads independent", async () => {
  initializeWorker();
  const owner = createChildAbortController(context.signal);
  const { bridge } = connectProtocolTransport(owner.signal);
  await bridge.registerTab(owner.signal);
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
    async ({ params, query, request, respond }) => {
      expect(request.headers.get("x-client-version")).toBe(WORKER_APP_VERSION);
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

  const first = bridge.query(
    { dataKey: firstKey, afterSeqId: null, consistency: "catch-up" },
    owner.signal,
  );
  const second = bridge.query(
    { dataKey: secondKey, afterSeqId: null, consistency: "catch-up" },
    owner.signal,
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

test("Authenticate worker requests through the first registered tab", async () => {
  initializeWorker();
  const firstOwner = createChildAbortController(context.signal);
  const secondOwner = createChildAbortController(context.signal);
  const first = connectProtocolTransport(firstOwner.signal, () => {
    return Promise.resolve("first-tab-token");
  });
  const second = connectProtocolTransport(secondOwner.signal, () => {
    return Promise.resolve("second-tab-token");
  });
  await first.bridge.registerTab(firstOwner.signal);
  await second.bridge.registerTab(secondOwner.signal);
  const key = dataKey(crypto.randomUUID());

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
    ({ query, request, respond }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer first-tab-token",
      );
      return respond(200, chatEventRowsResponse([], query));
    },
  );

  await expect(
    second.bridge.query(
      { dataKey: key, afterSeqId: null, consistency: "catch-up" },
      secondOwner.signal,
    ),
  ).resolves.toStrictEqual([]);
});

test("Cancel one shared chat load without cancelling worker progress", async () => {
  initializeWorker();
  const owner = createChildAbortController(context.signal);
  const { bridge, workerPort } = connectProtocolTransport(owner.signal);
  await bridge.registerTab(owner.signal);
  const key = dataKey(crypto.randomUUID());
  const canonicalRow = row(key.threadId, 1);
  const requestStarted = context.mocks.deferred<void>();
  const releaseRequest = context.mocks.deferred<void>();

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
        requestStarted.resolve(undefined);
        await releaseRequest.promise;
        return respond(200, chatEventRowsResponse([canonicalRow], query));
      }
      return respond(200, chatEventRowsResponse([], query));
    },
  );

  const caller = createChildAbortController(owner.signal);
  const pending = bridge.query(
    { dataKey: key, afterSeqId: null, consistency: "catch-up" },
    caller.signal,
  );
  await requestStarted.promise;
  caller.abort(new DOMException("Caller left", "AbortError"));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  releaseRequest.resolve(undefined);

  await vi.waitFor(async () => {
    await expect(
      bridge.query(
        { dataKey: key, afterSeqId: null, consistency: "cache-only" },
        owner.signal,
      ),
    ).resolves.toStrictEqual([canonicalRow]);
  });
  expect(workerPort.closed).toBeFalsy();
});

test("Disconnect one tab without interrupting another tab", async () => {
  initializeWorker();
  const firstOwner = createChildAbortController(context.signal);
  const secondOwner = createChildAbortController(context.signal);
  const first = connectProtocolTransport(firstOwner.signal);
  const second = connectProtocolTransport(secondOwner.signal);
  await first.bridge.registerTab(firstOwner.signal);
  await second.bridge.registerTab(secondOwner.signal);

  firstOwner.abort(new DOMException("First tab closed", "AbortError"));
  await vi.waitFor(() => {
    expect(first.workerPort.closed).toBeTruthy();
  });

  await expect(
    second.bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      secondOwner.signal,
    ),
  ).resolves.toStrictEqual([]);
  expect(second.workerPort.closed).toBeFalsy();
});

test("Reject shared-data access before the tab is registered", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);

  await expect(
    bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      context.signal,
    ),
  ).rejects.toThrow(
    "Shared database tab registration is required before query",
  );
});

test("Validate shared chat results received from the worker", async () => {
  const [platformPort, workerPort] = messagePortPair();
  const owner = createChildAbortController(context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    bridgeEvents(),
    owner.signal,
    () => {
      return Promise.resolve("test-token");
    },
  );
  workerPort.addEventListener("message", (event) => {
    const message = event.data;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "query" &&
      "requestId" in message &&
      typeof message.requestId === "string"
    ) {
      workerPort.postMessage({
        type: "result",
        requestId: message.requestId,
        value: [{ malformed: true }],
      });
    }
  });
  workerPort.start();
  await bridge.registerTab(owner.signal);

  await expect(
    bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      owner.signal,
    ),
  ).rejects.toMatchObject({ name: "ZodError" });
});

test("Stop pending requests when the bridge lifecycle ends", async () => {
  const [platformPort, workerPort] = messagePortPair();
  const owner = createChildAbortController(context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    bridgeEvents(),
    owner.signal,
    () => {
      return Promise.resolve("test-token");
    },
  );
  const requestsStarted = context.mocks.deferred<void>();
  const requestIds = new Map<"get-computed" | "query", string>();
  workerPort.addEventListener("message", (event) => {
    const message = event.data;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message.type === "get-computed" || message.type === "query") &&
      "requestId" in message &&
      typeof message.requestId === "string"
    ) {
      requestIds.set(message.type, message.requestId);
      if (requestIds.size === 2) {
        requestsStarted.resolve(undefined);
      }
    }
  });
  workerPort.start();
  await bridge.registerTab(owner.signal);

  const caller = createChildAbortController(context.signal);
  const pendingQuery = bridge.query(
    {
      dataKey: dataKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "cache-only",
    },
    caller.signal,
  );
  const pendingComputed = bridge.getComputed("chat-thread-indicators");
  await requestsStarted.promise;
  const reason = new DOMException("Bridge closed", "AbortError");
  owner.abort(reason);

  await expect(pendingQuery).rejects.toBe(reason);
  await expect(pendingComputed).rejects.toBe(reason);
  expect(platformPort.closed).toBeTruthy();

  for (const requestId of requestIds.values()) {
    workerPort.postMessage({
      type: "result",
      requestId,
      value: { agents: {}, threads: {} },
    });
  }
  await expect(bridge.getComputed("chat-thread-indicators")).rejects.toBe(
    reason,
  );
});

function mockBatchIndicators(threadId: string): void {
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: { [FeatureSwitchKey.BatchChatEventCatchUp]: true },
    });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: { [threadId]: "unread" } });
  });
}

test.each([false, undefined])(
  "Keep legacy indicator catch-up when the batch switch is %s",
  async (enabled) => {
    mockNow(40_000, context.signal);
    const threadId = crypto.randomUUID();
    const rows = [row(threadId, 1), row(threadId, 2)];
    let availableRows = rows.slice(0, 1);
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches:
          enabled === undefined
            ? {}
            : { [FeatureSwitchKey.BatchChatEventCatchUp]: enabled },
      });
    });
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, { agents: {}, threads: { [threadId]: "unread" } });
    });
    context.mocks.api(chatThreadEventsContract.catchUp, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Batch catch-up must remain disabled",
        },
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
      ({ params, query, respond }) => {
        return respond(
          200,
          chatEventRowsResponse(
            availableRows.filter((event) => {
              return (
                event.chatThreadId === params.threadId &&
                event.seqId > query.sinceSeqId
              );
            }),
            query,
          ),
        );
      },
    );
    initializeWorker();
    const { bridge } = connectProtocolTransport(context.signal);
    await bridge.registerTab(context.signal);
    await bridge.getComputed("chat-thread-indicators");
    const initial = await bridge.query(
      {
        dataKey: dataKey(threadId),
        afterSeqId: null,
        consistency: "cache-only",
      },
      context.signal,
    );
    expect(initial).toStrictEqual(rows.slice(0, 1));

    availableRows = rows;
    context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
    await expect(
      bridge.getComputed("chat-thread-indicators"),
    ).resolves.toStrictEqual({
      agents: {},
      threads: { [threadId]: "unread" },
    });
    const refreshed = await bridge.query(
      {
        dataKey: dataKey(threadId),
        afterSeqId: null,
        consistency: "cache-only",
      },
      context.signal,
    );
    expect(refreshed).toStrictEqual(rows);
  },
);

test("Continue warming unread chats after a trailing indicator catch-up completes", async () => {
  const startedAt = 10_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const rows = [row(threadId, 1), row(threadId, 2), row(threadId, 3)];
  let availableRows = rows.slice(0, 1);
  mockBatchIndicators(threadId);
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, sinceSeqId]) => {
          return [
            id,
            availableRows.filter((event) => {
              return event.chatThreadId === id && event.seqId > sinceSeqId;
            }),
          ];
        }),
      ),
      notFoundThreads: [],
    });
  });
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  await bridge.getComputed("chat-thread-indicators");

  availableRows = rows.slice(0, 2);
  mockNow(startedAt + 999, context.signal);
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  const indicators = await Promise.all([
    bridge.getComputed("chat-thread-indicators"),
    bridge.getComputed("chat-thread-indicators"),
  ]);
  expect(indicators).toStrictEqual([
    { agents: {}, threads: { [threadId]: "unread" } },
    { agents: {}, threads: { [threadId]: "unread" } },
  ]);
  const second = await bridge.query(
    { dataKey: dataKey(threadId), afterSeqId: null, consistency: "cache-only" },
    context.signal,
  );
  expect(second).toStrictEqual(rows.slice(0, 2));

  availableRows = rows;
  mockNow(startedAt + 2000, context.signal);
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  await bridge.getComputed("chat-thread-indicators");
  const third = await bridge.query(
    { dataKey: dataKey(threadId), afterSeqId: null, consistency: "cache-only" },
    context.signal,
  );
  expect(third).toStrictEqual(rows);
});

test("Recover indicator catch-up after a shared trailing request fails", async () => {
  const startedAt = 20_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const recoveredRows = [row(threadId, 1), row(threadId, 2)];
  let availableRows = recoveredRows.slice(0, 1);
  let failCatchUp = false;
  mockBatchIndicators(threadId);
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    if (failCatchUp) {
      return respond(500, {
        error: { message: "Catch-up failed", code: "INTERNAL_SERVER_ERROR" },
      });
    }
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, sinceSeqId]) => {
          return [
            id,
            availableRows.filter((event) => {
              return event.chatThreadId === id && event.seqId > sinceSeqId;
            }),
          ];
        }),
      ),
      notFoundThreads: [],
    });
  });
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  await bridge.getComputed("chat-thread-indicators");

  failCatchUp = true;
  mockNow(startedAt + 999, context.signal);
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  await Promise.all([
    expect(bridge.getComputed("chat-thread-indicators")).rejects.toThrow(
      "Shared database request failed with status 500",
    ),
    expect(bridge.getComputed("chat-thread-indicators")).rejects.toThrow(
      "Shared database request failed with status 500",
    ),
  ]);

  failCatchUp = false;
  availableRows = recoveredRows;
  mockNow(startedAt + 2000, context.signal);
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  await expect(
    bridge.getComputed("chat-thread-indicators"),
  ).resolves.toStrictEqual({
    agents: {},
    threads: { [threadId]: "unread" },
  });
  const cached = await bridge.query(
    { dataKey: dataKey(threadId), afterSeqId: null, consistency: "cache-only" },
    context.signal,
  );
  expect(cached).toStrictEqual(recoveredRows);
});

test("Cancel waiting indicator reads when their Worker lifecycle ends", async () => {
  mockNow(30_000, context.signal);
  const threadId = crypto.randomUUID();
  const worker = createChildAbortController(context.signal);
  const refreshLoaded = context.mocks.deferred<void>();
  let refreshing = false;
  mockBatchIndicators(threadId);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    if (refreshing && !refreshLoaded.settled()) {
      refreshLoaded.resolve();
    }
    return respond(200, { agents: {}, threads: { [threadId]: "unread" } });
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id]) => {
          return [id, []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  initializeWorker(worker.signal);
  const connectionId = crypto.randomUUID();
  context.workerStore.set(
    registerConnection$,
    connectionId,
    worker,
    {
      getToken: () => {
        return Promise.resolve("message-port-token");
      },
      port: new InMemoryMessagePort(),
    },
    worker.signal,
  );
  // Observe the Worker request directly: abort closes its message port before
  // the server can send a response to the client.
  const readIndicators = () => {
    return context.workerStore.set(
      getComputedStoreMessage$,
      connectionId,
      {
        type: "get-computed",
        requestId: crypto.randomUUID(),
        computedKey: "chat-thread-indicators",
      },
      worker.signal,
    );
  };
  await readIndicators();

  refreshing = true;
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  await Promise.all([
    expect(readIndicators()).rejects.toMatchObject({
      name: "AbortError",
    }),
    expect(readIndicators()).rejects.toMatchObject({
      name: "AbortError",
    }),
    (async () => {
      await refreshLoaded.promise;
      worker.abort(new DOMException("Worker stopped", "AbortError"));
    })(),
  ]);
});
