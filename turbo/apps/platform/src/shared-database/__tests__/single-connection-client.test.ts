import { expect, test, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import {
  createChildAbortController,
  createDeferredPromise,
} from "../../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
} from "../bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import type { ComputedKey, ComputedValue } from "../computed-key.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseConnectionStatus,
  type SharedDatabaseHeartbeatResult,
} from "../protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../single-connection-client.ts";

class FakeBridge implements SharedDatabaseBridge {
  readonly heartbeats: SharedDatabaseHeartbeat[] = [];
  readonly heartbeatSignals: AbortSignal[] = [];
  heartbeatCalls = 0;
  queryCalls = 0;
  queryError: Error | null = null;
  pendingQuery = false;
  timeoutHeartbeatCall: number | null = null;

  getComputed<TKey extends ComputedKey>(
    _computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return Promise.reject(new Error("Computed data is not configured"));
  }

  reloadComputed(_computedKey: ComputedKey): void {}

  setToken(
    _recoveryId: string,
    _token: string | null,
    _signal: AbortSignal,
  ): Promise<void> {
    return Promise.resolve();
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
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    this.queryCalls += 1;
    if (this.queryError) {
      const error = this.queryError;
      this.queryError = null;
      return Promise.reject(error);
    }
    if (this.pendingQuery) {
      return createDeferredPromise<SharedDatabaseQueryResult<TKey>>(signal)
        .promise;
    }
    return Promise.resolve([] as SharedDatabaseQueryResult<TKey>);
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
    threadId: "single-connection-thread",
  };
}

function clientNotConnectedError(): Error {
  const error = new Error("Shared database client is not connected");
  error.name = SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME;
  return error;
}

function createEvents(
  statuses: SharedDatabaseConnectionStatus[] = [],
): SharedDatabaseBridgeEvents {
  return {
    authenticationRequired: vi.fn<(recoveryId: string) => void>(),
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    databaseReconnected: vi.fn<() => void>(),
    reloadRequired: vi.fn<() => void>(),
    statusChanged: (status) => {
      statuses.push(status);
    },
  };
}

function query() {
  return {
    dataKey: dataKey(),
    afterSeqId: null,
    consistency: "cache-only" as const,
  };
}

test("Reload a page whose live-data connection stops responding", async () => {
  const bridges: FakeBridge[] = [];
  const statuses: SharedDatabaseConnectionStatus[] = [];
  const events = createEvents(statuses);
  const bridge = new SingleConnectionSharedDatabaseBridge({
    controlRequestTimeoutMs: 10,
    createBridge: () => {
      const created = new FakeBridge();
      bridges.push(created);
      return created;
    },
    events,
  });
  const owner = createChildAbortController(context.signal);
  await bridge.heartbeat(heartbeat({}, "preview-secret"), owner.signal);
  const firstBridge = bridges[0]!;
  firstBridge.timeoutHeartbeatCall = 2;

  const pendingHeartbeat = bridge.heartbeat(
    heartbeat({ token: "replacement-token" }, "preview-secret"),
    owner.signal,
  );
  await vi.waitFor(() => {
    expect(events.reloadRequired).toHaveBeenCalledOnce();
  });

  expect(bridges).toHaveLength(1);
  expect(firstBridge.heartbeatSignals[0]?.aborted).toBeFalsy();
  expect(statuses).toStrictEqual(["connecting"]);

  owner.abort(new DOMException("App unloaded", "AbortError"));
  await expect(pendingHeartbeat).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("Reload when a tab's live-data session has expired", async () => {
  const bridges: FakeBridge[] = [];
  const events = createEvents();
  const bridge = new SingleConnectionSharedDatabaseBridge({
    createBridge: () => {
      const created = new FakeBridge();
      bridges.push(created);
      return created;
    },
    events,
  });
  const owner = createChildAbortController(context.signal);
  await bridge.heartbeat(heartbeat(), owner.signal);
  bridges[0]!.queryError = clientNotConnectedError();

  const pendingQuery = bridge.query(query(), owner.signal);
  await vi.waitFor(() => {
    expect(events.reloadRequired).toHaveBeenCalledOnce();
  });

  expect(bridges).toHaveLength(1);
  expect(bridges[0]!.queryCalls).toBe(1);
  owner.abort(new DOMException("App unloaded", "AbortError"));
  await expect(pendingQuery).rejects.toMatchObject({ name: "AbortError" });
});
