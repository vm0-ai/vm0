import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import {
  createChildAbortController,
  createDeferredPromise,
} from "../../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "../bridge.ts";
import {
  parseComputedValue,
  type ComputedKey,
  type ComputedValue,
} from "../computed-key.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseConnectionStatus,
} from "../protocol.ts";
import { SingleConnectionSharedDatabaseBridge } from "../single-connection-client.ts";

class FakeBridge implements SharedDatabaseBridge {
  readonly registrationSignals: AbortSignal[] = [];
  queryCalls = 0;
  queryError: Error | null = null;
  pendingQuery = false;

  registerTab(signal: AbortSignal): Promise<void> {
    this.registrationSignals.push(signal);
    return Promise.resolve();
  }

  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const value =
      computedKey === "chat-thread-indicators"
        ? { agents: {}, threads: {} }
        : [];
    return Promise.resolve(parseComputedValue(computedKey, value));
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

function dataKey(): SharedDatabaseDataKey {
  return { kind: "chat-event", threadId: "single-connection-thread" };
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
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    databaseReconnected: vi.fn<() => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    workerUnavailable: vi.fn<SharedDatabaseBridgeEvents["workerUnavailable"]>(),
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

describe("single-connection shared database bridge", () => {
  it("prepares one transport and registers the tab once", async () => {
    const bridges: FakeBridge[] = [];
    const statuses: SharedDatabaseConnectionStatus[] = [];
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: () => {
        const created = new FakeBridge();
        bridges.push(created);
        return created;
      },
      events: createEvents(statuses),
    });
    const owner = createChildAbortController(context.signal);

    await bridge.prepare(owner.signal);

    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.registrationSignals).toStrictEqual([]);
    expect(statuses).toStrictEqual(["connecting"]);

    await bridge.registerTab(owner.signal);

    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.registrationSignals).toHaveLength(1);
    owner.abort();
  });

  it("requests a reload when transport construction fails", async () => {
    const statuses: SharedDatabaseConnectionStatus[] = [];
    const events = createEvents(statuses);
    const bridge = new SingleConnectionSharedDatabaseBridge({
      createBridge: () => {
        throw new Error("SharedWorker construction failed");
      },
      events,
    });
    const owner = createChildAbortController(context.signal);

    const registration = bridge.registerTab(owner.signal);
    await vi.waitFor(() => {
      expect(events.workerUnavailable).toHaveBeenCalledWith(
        "worker-load-or-transport-failure",
      );
    });

    expect(statuses).toStrictEqual(["connecting"]);
    owner.abort(new DOMException("App unloaded", "AbortError"));
    await expect(registration).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requests a reload after the registered port expires", async () => {
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
    await bridge.registerTab(owner.signal);
    bridges[0]!.queryError = clientNotConnectedError();

    const pendingQuery = bridge.query(query(), owner.signal);
    await vi.waitFor(() => {
      expect(events.workerUnavailable).toHaveBeenCalledWith(
        "worker-load-or-transport-failure",
      );
    });

    expect(bridges[0]!.queryCalls).toBe(1);
    owner.abort(new DOMException("App unloaded", "AbortError"));
    await expect(pendingQuery).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not reload when a query caller aborts", async () => {
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
    const caller = createChildAbortController(context.signal);
    await bridge.registerTab(owner.signal);
    bridges[0]!.pendingQuery = true;

    const pendingQuery = bridge.query(query(), caller.signal);
    caller.abort(new DOMException("Query cancelled", "AbortError"));

    await expect(pendingQuery).rejects.toMatchObject({ name: "AbortError" });
    expect(events.workerUnavailable).not.toHaveBeenCalled();
    owner.abort();
  });
});
