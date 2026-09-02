import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { Store } from "ccstate";
import { expect, test, vi } from "vitest";

import { mockNow } from "../../lib/time.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import { queryChatEventSharedDatabase$ } from "../../signals/shared-database.ts";
import { installSharedDatabaseBridge$ } from "../../signals/shared-database-bridge-state.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabasePortLike,
} from "../bridge.ts";
import type {
  ChatEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../data-key.ts";
import type { ComputedKey } from "../computed-key.ts";
import { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "../message-port-server.ts";
import type {
  SharedDatabaseClientMessage,
  SharedDatabaseConnectionStatus,
} from "../protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../single-connection-client.ts";
import { SharedDatabaseWorkerContext } from "../worker-host-context.ts";

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
    _options?: AddEventListenerOptions | boolean,
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

function installHeartbeatAuthentication(): void {
  const current = identity();
  context.mocks.api(authContract.me, ({ request, respond }) => {
    expect(request.headers.get("x-client-version")).toBe(WORKER_APP_VERSION);
    return respond(200, {
      userId: current.userId,
      email: "message-port@example.com",
      orgId: current.orgId,
    });
  });
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
    authenticationRequired: vi.fn<(recoveryId: string) => void>(),
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    databaseReconnected: vi.fn<() => void>(),
    reloadRequired: vi.fn<() => void>(),
    statusChanged: vi.fn<(status: SharedDatabaseConnectionStatus) => void>(),
  };
}

function connectProtocolTransport(
  workerContext: SharedDatabaseWorkerContext,
  events: SharedDatabaseBridgeEvents,
): MessagePortSharedDatabaseBridge {
  const [platformPort, workerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    workerContext,
    workerPort,
    context.signal,
  );
  return new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    events,
  );
}

async function installProtocolBridge(): Promise<{
  readonly platformStore: Store;
  readonly workerContext: SharedDatabaseWorkerContext;
}> {
  const platformStore = context.store;
  const workerContext = new SharedDatabaseWorkerContext(
    context.signal,
    WORKER_APP_VERSION,
  );
  installHeartbeatAuthentication();
  const bridge = connectProtocolTransport(workerContext, bridgeEvents());
  await platformStore.set(
    installSharedDatabaseBridge$,
    bridge,
    heartbeat(),
    context.signal,
  );
  return { platformStore, workerContext };
}

test("Keep concurrent chat loads independent", async () => {
  const { platformStore } = await installProtocolBridge();

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

test("Continue shared recovery after one tab leaves", async () => {
  const { platformStore } = await installProtocolBridge();
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
  caller.abort(new DOMException("connection query cancelled", "AbortError"));
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

test("Reload only the stale tab when its shared-data session expires", async () => {
  installHeartbeatAuthentication();
  const workerContext = new SharedDatabaseWorkerContext(
    context.signal,
    WORKER_APP_VERSION,
  );
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  mockNow(start, context.signal);
  let activeConnectionTransports = 0;
  let staleConnectionTransports = 0;
  const activeEvents = bridgeEvents();
  const staleEvents = bridgeEvents();
  const activeConnection = new SingleConnectionSharedDatabaseBridge({
    controlRequestTimeoutMs: 10,
    createBridge: (events) => {
      activeConnectionTransports += 1;
      return connectProtocolTransport(workerContext, events);
    },
    events: activeEvents,
  });
  const staleConnection = new SingleConnectionSharedDatabaseBridge({
    controlRequestTimeoutMs: 10,
    createBridge: (events) => {
      staleConnectionTransports += 1;
      return connectProtocolTransport(workerContext, events);
    },
    events: staleEvents,
  });
  const activeOwner = createChildAbortController(context.signal);
  const staleOwner = createChildAbortController(context.signal);

  await activeConnection.heartbeat(heartbeat(), activeOwner.signal);
  await staleConnection.heartbeat(heartbeat(), staleOwner.signal);
  expect(workerContext.credentialStoreCount()).toBe(1);

  mockNow(start + 2 * 60 * 1000, context.signal);
  await activeConnection.heartbeat(heartbeat(), activeOwner.signal);
  mockNow(start + 4 * 60 * 1000, context.signal);
  await activeConnection.heartbeat(heartbeat(), activeOwner.signal);
  const staleHeartbeat = staleConnection.heartbeat(
    heartbeat(),
    staleOwner.signal,
  );
  await vi.waitFor(() => {
    expect(staleEvents.reloadRequired).toHaveBeenCalledOnce();
  });

  expect(activeConnectionTransports).toBe(1);
  expect(staleConnectionTransports).toBe(1);
  expect(activeEvents.reloadRequired).not.toHaveBeenCalled();
  expect(workerContext.credentialStoreCount()).toBe(1);
  staleOwner.abort(new DOMException("App unloaded", "AbortError"));
  await expect(staleHeartbeat).rejects.toMatchObject({ name: "AbortError" });
  activeOwner.abort();
  await vi.waitFor(() => {
    expect(workerContext.credentialStoreCount()).toBe(0);
  });
});

test("Disconnecting a changed tab leaves other shared-data tabs usable", async () => {
  context.mocks.api(authContract.me, ({ request, respond }) => {
    const secondCredential =
      request.headers.get("authorization") === "Bearer second-token";
    return respond(200, {
      userId: identity().userId,
      email: "message-port@example.com",
      orgId: secondCredential ? "second-org" : identity().orgId,
    });
  });
  const workerContext = new SharedDatabaseWorkerContext(
    context.signal,
    WORKER_APP_VERSION,
  );
  const [movingPlatformPort, movingWorkerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    workerContext,
    movingWorkerPort,
    context.signal,
  );
  const movingEvents = bridgeEvents();
  const movingBridge = new MessagePortSharedDatabaseBridge(
    movingPlatformPort,
    location.origin,
    movingEvents,
  );
  const [keeperPlatformPort, keeperWorkerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    workerContext,
    keeperWorkerPort,
    context.signal,
  );
  const keeperEvents = bridgeEvents();
  const keeperBridge = new MessagePortSharedDatabaseBridge(
    keeperPlatformPort,
    location.origin,
    keeperEvents,
  );
  const movingOwner = createChildAbortController(context.signal);
  const keeperOwner = createChildAbortController(context.signal);

  await movingBridge.heartbeat({ token: "first-token" }, movingOwner.signal);
  await keeperBridge.heartbeat({ token: "keeper-token" }, keeperOwner.signal);
  expect(workerContext.credentialStoreCount()).toBe(1);
  const key = dataKey(crypto.randomUUID());
  const oldRow = row(key.threadId, 1);
  const oldRequestGate = context.mocks.deferred<void>();
  const oldRequestHandlerFinished = context.mocks.deferred<void>();
  let oldRequestStarted = false;
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
      if (query.sinceSeqId > 0) {
        return respond(200, chatEventRowsResponse([], query));
      }
      oldRequestStarted = true;
      await oldRequestGate.promise;
      oldRequestHandlerFinished.resolve(undefined);
      return respond(200, chatEventRowsResponse([oldRow], query));
    },
  );
  const oldRequest = movingBridge.query(
    { dataKey: key, afterSeqId: null, consistency: "catch-up" },
    movingOwner.signal,
  );
  await vi.waitFor(() => {
    expect(oldRequestStarted).toBeTruthy();
  });
  const oldQueryMessage = movingPlatformPort.postedMessages.find((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "query"
    );
  }) as
    | Extract<SharedDatabaseClientMessage, { readonly type: "query" }>
    | undefined;
  expect(oldQueryMessage).toBeDefined();
  if (!oldQueryMessage) {
    throw new Error("Expected the old credential query message");
  }

  await movingBridge.heartbeat({ token: "second-token" }, movingOwner.signal);
  expect(movingEvents.reloadRequired).not.toHaveBeenCalled();
  expect(movingWorkerPort.closed).toBeFalsy();
  expect(keeperEvents.reloadRequired).not.toHaveBeenCalled();
  expect(keeperWorkerPort.closed).toBeFalsy();
  await expect(
    keeperBridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      keeperOwner.signal,
    ),
  ).resolves.toStrictEqual([]);

  movingOwner.abort(new DOMException("Account context changed", "AbortError"));
  await expect(oldRequest).rejects.toMatchObject({ name: "AbortError" });
  oldRequestGate.resolve(undefined);
  await oldRequestHandlerFinished.promise;
  await vi.waitFor(() => {
    expect(movingWorkerPort.closed).toBeTruthy();
    expect(workerContext.credentialStoreCount()).toBe(1);
  });
  const [secondPlatformPort, secondWorkerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    workerContext,
    secondWorkerPort,
    context.signal,
  );
  const secondBridge = new MessagePortSharedDatabaseBridge(
    secondPlatformPort,
    location.origin,
    bridgeEvents(),
  );
  const secondOwner = createChildAbortController(context.signal);
  await secondBridge.heartbeat({ token: "second-token" }, secondOwner.signal);
  expect(secondWorkerPort.closed).toBeFalsy();
  expect(workerContext.credentialStoreCount()).toBe(2);
  const oldResponses = movingWorkerPort.postedMessages.filter((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "requestId" in message &&
      message.requestId === oldQueryMessage.requestId
    );
  });
  expect(oldResponses).toStrictEqual([]);

  secondOwner.abort();
  keeperOwner.abort();
  await vi.waitFor(() => {
    expect(workerContext.credentialStoreCount()).toBe(0);
  });
});

test("Stay on the current page when session access is renewed", async () => {
  installHeartbeatAuthentication();
  const authorizationHeaders: (string | null)[] = [];
  let recoveryId: string | null = null;
  context.mocks.api(
    chatThreadEventsContract.snapshot,
    ({ request, respond }) => {
      const authorization = request.headers.get("authorization");
      authorizationHeaders.push(authorization);
      if (authorization === "Bearer first-token") {
        return respond(401, {
          error: { code: "UNAUTHORIZED", message: "Session expired" },
        });
      }
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    },
  );
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ query, request, respond }) => {
      authorizationHeaders.push(request.headers.get("authorization"));
      return respond(200, chatEventRowsResponse([], query));
    },
  );
  const workerContext = new SharedDatabaseWorkerContext(
    context.signal,
    WORKER_APP_VERSION,
  );
  const [platformPort, workerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    workerContext,
    workerPort,
    context.signal,
  );
  const events: SharedDatabaseBridgeEvents = {
    ...bridgeEvents(),
    authenticationRequired: (requestedRecoveryId) => {
      recoveryId = requestedRecoveryId;
    },
  };
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    events,
  );
  const owner = createChildAbortController(context.signal);

  await bridge.heartbeat({ token: "first-token" }, owner.signal);
  const query = bridge.query(
    {
      dataKey: dataKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "catch-up",
    },
    owner.signal,
  );
  await vi.waitFor(() => {
    expect(recoveryId).not.toBeNull();
  });
  if (recoveryId === null) {
    throw new Error("Session renewal was not requested");
  }
  await bridge.setToken(recoveryId, "refreshed-token", owner.signal);
  await expect(query).resolves.toStrictEqual([]);

  expect(authorizationHeaders.length).toBeGreaterThan(0);
  expect(new Set(authorizationHeaders)).toStrictEqual(
    new Set(["Bearer first-token", "Bearer refreshed-token"]),
  );
  expect(events.reloadRequired).not.toHaveBeenCalled();
  expect(workerPort.closed).toBeFalsy();
  expect(workerContext.credentialStoreCount()).toBe(1);
  owner.abort();
  await vi.waitFor(() => {
    expect(workerContext.credentialStoreCount()).toBe(0);
  });
});

test("Report realtime connection state truthfully", async () => {
  const [platformPort, serverPort] = messagePortPair();
  const statuses: SharedDatabaseConnectionStatus[] = [];
  const invalidations: SharedDatabaseDataKey[] = [];
  let reconnects = 0;
  let authenticationRequests = 0;
  const computedReloads: ComputedKey[] = [];
  const readCursorUpdates: unknown[] = [];
  let reloads = 0;
  let observedHeartbeat: SharedDatabaseClientMessage | null = null;
  const key = dataKey(crypto.randomUUID());
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    location.origin,
    {
      authenticationRequired: () => {
        authenticationRequests += 1;
      },
      chatThreadReadCursorUpdated: (payload) => {
        readCursorUpdates.push(payload);
      },
      computedReloaded: (computedKey) => {
        computedReloads.push(computedKey);
      },
      databaseInvalidated: (invalidatedKey) => {
        invalidations.push(invalidatedKey);
      },
      databaseReconnected: () => {
        reconnects += 1;
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

  serverPort.postMessage({ type: "invalidate", dataKey: key });
  serverPort.postMessage({ type: "reconnect" });
  serverPort.postMessage({
    type: "authentication-required",
    recoveryId: "recovery-1",
  });
  const indicatorPayload = {
    threadId: crypto.randomUUID(),
    lastReadAt: null,
  };
  serverPort.postMessage({
    type: "chat-thread-read-cursor-updated",
    payload: indicatorPayload,
  });
  serverPort.postMessage({
    type: "reload-computed",
    computedKey: "chat-thread-indicators",
  });
  serverPort.postMessage({ type: "status", status: "disconnected" });
  serverPort.postMessage({ type: "reload-required" });
  await vi.waitFor(() => {
    expect(invalidations).toStrictEqual([key]);
    expect(reconnects).toBe(1);
    expect(statuses).toStrictEqual(["disconnected"]);
    expect(authenticationRequests).toBe(1);
    expect(readCursorUpdates).toStrictEqual([indicatorPayload]);
    expect(computedReloads).toStrictEqual(["chat-thread-indicators"]);
    expect(reloads).toBe(1);
  });

  await expect(
    bridge.query(
      { dataKey: key, afterSeqId: null, consistency: "cache-only" },
      owner.signal,
    ),
  ).rejects.toMatchObject({ name: "ZodError" });
  owner.abort();
});
