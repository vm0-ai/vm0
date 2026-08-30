import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import {
  createChildAbortController,
  createDeferredPromise,
} from "../../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
  SharedDatabaseSubscriptionCallback,
} from "../bridge.ts";
import type {
  ChatThreadIndicators,
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseConnectionStatus,
  type SharedDatabaseHeartbeatResult,
} from "../protocol.ts";
import {
  ReconnectingSharedDatabaseBridge,
  SharedDatabaseTransportError,
} from "../reconnecting-client.ts";

class FakeBridge implements SharedDatabaseBridge {
  readonly callbacks: SharedDatabaseSubscriptionCallback[] = [];
  readonly heartbeats: SharedDatabaseHeartbeat[] = [];
  readonly heartbeatSignals: AbortSignal[] = [];
  heartbeatCalls = 0;
  queryCalls = 0;
  subscribeCalls = 0;
  queryError: Error | null = null;
  subscribeError: Error | null = null;
  timeoutHeartbeatCall: number | null = null;

  indicators(_signal: AbortSignal): Promise<ChatThreadIndicators> {
    return Promise.resolve({ agents: {}, threads: {} });
  }

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.heartbeatCalls += 1;
    this.heartbeats.push(heartbeat);
    this.heartbeatSignals.push(signal);
    if (this.heartbeatCalls === this.timeoutHeartbeatCall) {
      await createDeferredPromise<void>(signal).promise;
    }
    return { clientReconnected: false };
  }

  query<TKey extends SharedDatabaseDataKey>(
    _query: SharedDatabaseQuery<TKey>,
    _signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    this.queryCalls += 1;
    if (this.queryError) {
      const error = this.queryError;
      this.queryError = null;
      return Promise.reject(error);
    }
    return Promise.resolve([] as SharedDatabaseQueryResult<TKey>);
  }

  on(
    _dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void> {
    this.subscribeCalls += 1;
    if (this.subscribeError) {
      const error = this.subscribeError;
      this.subscribeError = null;
      return Promise.reject(error);
    }
    this.callbacks.push(callback);
    signal.addEventListener(
      "abort",
      () => {
        const index = this.callbacks.indexOf(callback);
        if (index !== -1) {
          this.callbacks.splice(index, 1);
        }
      },
      { once: true },
    );
    return Promise.resolve();
  }
}

const context = testContext();

function heartbeat(
  overrides: Partial<SharedDatabaseHeartbeat> = {},
  vercelProtectionBypass?: string,
): SharedDatabaseHeartbeat {
  return {
    token: "first-token",
    ...overrides,
    ...(vercelProtectionBypass ? { vercelProtectionBypass } : {}),
  };
}

function dataKey(): SharedDatabaseDataKey {
  return {
    kind: "chat-event",
    threadId: "reconnecting-thread",
  };
}

function clientNotConnectedError(): Error {
  const error = new Error("Shared database client is not connected");
  error.name = SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME;
  return error;
}

describe("reconnecting shared database bridge", () => {
  it("recreates the revisioned transport and restores live subscriptions after heartbeat timeout", async () => {
    const bridges: FakeBridge[] = [];
    const statuses: SharedDatabaseConnectionStatus[] = [];
    const bridge = new ReconnectingSharedDatabaseBridge({
      controlRequestTimeoutMs: 10,
      createBridge: () => {
        const created = new FakeBridge();
        bridges.push(created);
        return created;
      },
      events: {
        authenticationRequired: vi.fn<() => void>(),
        indicatorsInvalidated: vi.fn<() => void>(),
        reloadRequired: vi.fn<() => void>(),
        statusChanged: (status) => {
          statuses.push(status);
        },
      },
    });
    const owner = createChildAbortController(context.signal);
    await bridge.heartbeat(heartbeat({}, "preview-secret"), owner.signal);
    expect(bridges).toHaveLength(1);

    let appends = 0;
    const subscription = createChildAbortController(context.signal);
    await bridge.on(
      dataKey(),
      () => {
        appends += 1;
      },
      subscription.signal,
    );
    const firstBridge = bridges[0]!;
    firstBridge.timeoutHeartbeatCall = 2;

    await bridge.heartbeat(
      heartbeat({ token: "replacement-token" }, "preview-secret"),
      owner.signal,
    );

    expect(bridges).toHaveLength(2);
    expect(firstBridge.heartbeatSignals[0]?.aborted).toBeTruthy();
    const recoveredBridge = bridges[1]!;
    expect(recoveredBridge.heartbeats).toMatchObject([
      { vercelProtectionBypass: "preview-secret" },
    ]);
    expect(recoveredBridge.callbacks).toHaveLength(1);
    recoveredBridge.callbacks[0]?.("append");
    expect(appends).toBe(1);
    expect(statuses).toStrictEqual([
      "connecting",
      "disconnected",
      "connecting",
    ]);

    subscription.abort();
    expect(recoveredBridge.callbacks).toHaveLength(0);
    owner.abort();
  });

  it("retries a query after client expiry and restores subscriptions once", async () => {
    const bridges: FakeBridge[] = [];
    const bridge = new ReconnectingSharedDatabaseBridge({
      createBridge: () => {
        const created = new FakeBridge();
        bridges.push(created);
        return created;
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
    await bridge.heartbeat(heartbeat(), owner.signal);
    let appends = 0;
    await bridge.on(
      dataKey(),
      () => {
        appends += 1;
      },
      subscription.signal,
    );
    const firstBridge = bridges[0]!;
    firstBridge.queryError = clientNotConnectedError();

    await expect(
      bridge.query(
        {
          dataKey: dataKey(),
          afterSeqId: null,
          consistency: "cache-only",
        },
        owner.signal,
      ),
    ).resolves.toStrictEqual([]);

    expect(bridges).toHaveLength(2);
    expect(firstBridge.queryCalls).toBe(1);
    expect(firstBridge.callbacks).toHaveLength(0);
    const recoveredBridge = bridges[1]!;
    expect(recoveredBridge.queryCalls).toBe(1);
    expect(recoveredBridge.subscribeCalls).toBe(1);
    expect(recoveredBridge.callbacks).toHaveLength(1);
    recoveredBridge.callbacks[0]?.("append");
    expect(appends).toBe(1);

    subscription.abort();
    owner.abort();
  });

  it("retries a subscription once after client expiry", async () => {
    const bridges: FakeBridge[] = [];
    const bridge = new ReconnectingSharedDatabaseBridge({
      createBridge: () => {
        const created = new FakeBridge();
        bridges.push(created);
        return created;
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
    await bridge.heartbeat(heartbeat(), owner.signal);
    const firstBridge = bridges[0]!;
    firstBridge.subscribeError = clientNotConnectedError();

    await bridge.on(dataKey(), vi.fn<() => void>(), subscription.signal);

    expect(bridges).toHaveLength(2);
    expect(firstBridge.subscribeCalls).toBe(1);
    expect(firstBridge.callbacks).toHaveLength(0);
    expect(bridges[1]!.subscribeCalls).toBe(1);
    expect(bridges[1]!.callbacks).toHaveLength(1);

    subscription.abort();
    owner.abort();
  });

  it("allows a query caller to abort while shared transport recovery continues", async () => {
    const bridges: FakeBridge[] = [];
    const recovery = context.mocks.deferred<"reconnect">();
    let recoveryCalls = 0;
    const bridge = new ReconnectingSharedDatabaseBridge({
      createBridge: () => {
        const created = new FakeBridge();
        bridges.push(created);
        return created;
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
    const caller = createChildAbortController(context.signal);
    await bridge.heartbeat(heartbeat(), owner.signal);
    bridges[0]!.queryError = new SharedDatabaseTransportError(
      "Shared database worker failed to load",
      () => {
        recoveryCalls += 1;
        return recovery.promise;
      },
    );

    const query = bridge.query(
      {
        dataKey: dataKey(),
        afterSeqId: null,
        consistency: "cache-only",
      },
      caller.signal,
    );
    await vi.waitFor(() => {
      expect(recoveryCalls).toBe(1);
    });
    caller.abort(new DOMException("Query cancelled", "AbortError"));

    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    expect(bridges).toHaveLength(1);
    expect(recoveryCalls).toBe(1);

    recovery.resolve("reconnect");
    owner.abort();
  });
});
