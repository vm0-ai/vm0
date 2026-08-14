import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import {
  createChildAbortController,
  createDeferredPromise,
} from "../../signals/utils.ts";
import type { SharedDatabaseBridge } from "../bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import type { SharedDatabaseConnectionStatus } from "../protocol.ts";
import { ReconnectingSharedDatabaseBridge } from "../reconnecting-client.ts";

class FakeBridge implements SharedDatabaseBridge {
  readonly callbacks: (() => void)[] = [];
  readonly heartbeatSignals: AbortSignal[] = [];
  heartbeatCalls = 0;
  timeoutHeartbeatCall: number | null = null;

  async heartbeat(
    _identity: SharedDatabaseIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    this.heartbeatCalls += 1;
    this.heartbeatSignals.push(signal);
    if (this.heartbeatCalls === this.timeoutHeartbeatCall) {
      await createDeferredPromise<void>(signal).promise;
    }
  }

  query<TKey extends SharedDatabaseDataKey>(
    _query: SharedDatabaseQuery<TKey>,
    _signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return Promise.resolve([] as SharedDatabaseQueryResult<TKey>);
  }

  on(
    _dataKey: SharedDatabaseDataKey,
    callback: () => void,
    signal: AbortSignal,
  ): Promise<void> {
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

function identity(): SharedDatabaseIdentity {
  return {
    userId: "reconnecting-user",
    orgId: "reconnecting-org",
    token: "first-token",
  };
}

function dataKey(): SharedDatabaseDataKey {
  const currentIdentity = identity();
  return {
    kind: "chat-event",
    userId: currentIdentity.userId,
    orgId: currentIdentity.orgId,
    threadId: "reconnecting-thread",
  };
}

describe("reconnecting shared database bridge", () => {
  it("recreates the revisioned transport and restores live subscriptions after heartbeat timeout", async () => {
    vi.useFakeTimers();
    try {
      const bridges: FakeBridge[] = [];
      const statuses: SharedDatabaseConnectionStatus[] = [];
      const bridge = new ReconnectingSharedDatabaseBridge({
        controlRequestTimeoutMs: 100,
        createBridge: () => {
          const created = new FakeBridge();
          bridges.push(created);
          return created;
        },
        events: {
          reloadRequired: vi.fn<() => void>(),
          statusChanged: (status) => {
            statuses.push(status);
          },
        },
      });
      const owner = createChildAbortController(context.signal);
      await bridge.heartbeat(identity(), owner.signal);
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

      const renewal = bridge.heartbeat(
        { ...identity(), token: "replacement-token" },
        owner.signal,
      );
      await vi.advanceTimersByTimeAsync(100);
      await renewal;

      expect(bridges).toHaveLength(2);
      expect(firstBridge.heartbeatSignals[0]?.aborted).toBeTruthy();
      const recoveredBridge = bridges[1]!;
      expect(recoveredBridge.callbacks).toHaveLength(1);
      recoveredBridge.callbacks[0]?.();
      expect(appends).toBe(1);
      expect(statuses).toStrictEqual([
        "connecting",
        "disconnected",
        "connecting",
      ]);

      subscription.abort();
      expect(recoveredBridge.callbacks).toHaveLength(0);
      owner.abort();
    } finally {
      vi.useRealTimers();
    }
  });
});
