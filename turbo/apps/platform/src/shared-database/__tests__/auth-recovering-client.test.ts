import { describe, expect, it, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import { AuthRecoveringSharedDatabaseBridge } from "../auth-recovering-client.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
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
  SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME,
  type SharedDatabaseHeartbeatResult,
} from "../protocol.ts";

class FakeBridge implements SharedDatabaseBridge {
  readonly heartbeats: SharedDatabaseHeartbeat[] = [];
  readonly queryErrors: Error[] = [];
  queryCalls = 0;

  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const value =
      computedKey === "chat-thread-indicators"
        ? { agents: {}, threads: {} }
        : [];
    return Promise.resolve(parseComputedValue(computedKey, value));
  }

  reloadComputed(_computedKey: ComputedKey): void {}

  heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    _signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.heartbeats.push(heartbeat);
    return Promise.resolve({ clientReconnected: false });
  }

  query<TKey extends SharedDatabaseDataKey>(
    _query: SharedDatabaseQuery<TKey>,
    _signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    this.queryCalls += 1;
    const error = this.queryErrors.shift();
    if (error) {
      return Promise.reject(error);
    }
    return Promise.resolve([] as SharedDatabaseQueryResult<TKey>);
  }
}

const context = testContext();

function heartbeat(token = "initial-token"): SharedDatabaseHeartbeat {
  return { token };
}

function dataKey(): SharedDatabaseDataKey {
  return {
    kind: "chat-event",
    threadId: "auth-recovery-thread",
  };
}

function query(
  bridge: AuthRecoveringSharedDatabaseBridge,
  signal: AbortSignal,
) {
  return bridge.query(
    {
      dataKey: dataKey(),
      afterSeqId: null,
      consistency: "catch-up",
    },
    signal,
  );
}

function authenticationBlockedError(): Error {
  const error = new Error(
    "Shared database remote synchronization is blocked by authentication",
  );
  error.name = SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME;
  return error;
}

describe("auth recovering shared database bridge", () => {
  it("refreshes the credential and retries an auth-blocked query once", async () => {
    const inner = new FakeBridge();
    inner.queryErrors.push(authenticationBlockedError());
    let refreshes = 0;
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        refreshes += 1;
        return Promise.resolve("replacement-token");
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);

    await expect(query(bridge, context.signal)).resolves.toStrictEqual([]);

    expect(refreshes).toBe(1);
    expect(inner.queryCalls).toBe(2);
    expect(
      inner.heartbeats.map((value) => {
        return value.token;
      }),
    ).toStrictEqual(["initial-token", "replacement-token"]);
  });

  it("coalesces worker-initiated authentication recovery", async () => {
    const inner = new FakeBridge();
    const refresh = context.mocks.deferred<string | null>();
    let refreshes = 0;
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        refreshes += 1;
        return refresh.promise;
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);

    const first = bridge.authenticationRequired();
    const second = bridge.authenticationRequired();
    expect(refreshes).toBe(1);
    refresh.resolve("replacement-token");
    await Promise.all([first, second]);

    expect(
      inner.heartbeats.map((value) => {
        return value.token;
      }),
    ).toStrictEqual(["initial-token", "replacement-token"]);
  });

  it("does not retry when Clerk returns the rejected token", async () => {
    const inner = new FakeBridge();
    const blocked = authenticationBlockedError();
    inner.queryErrors.push(blocked);
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        return Promise.resolve("initial-token");
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);

    await expect(query(bridge, context.signal)).rejects.toBe(blocked);

    expect(inner.queryCalls).toBe(1);
    expect(inner.heartbeats).toHaveLength(1);
  });

  it("allows a later recovery after a token refresh rejects", async () => {
    const inner = new FakeBridge();
    inner.queryErrors.push(
      authenticationBlockedError(),
      authenticationBlockedError(),
    );
    const refreshError = new Error("Clerk token refresh failed");
    let refreshes = 0;
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        refreshes += 1;
        return refreshes === 1
          ? Promise.reject(refreshError)
          : Promise.resolve("replacement-token");
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);

    await expect(query(bridge, context.signal)).rejects.toBe(refreshError);
    await expect(query(bridge, context.signal)).resolves.toStrictEqual([]);

    expect(refreshes).toBe(2);
    expect(inner.queryCalls).toBe(3);
    expect(
      inner.heartbeats.map((value) => {
        return value.token;
      }),
    ).toStrictEqual(["initial-token", "replacement-token"]);
  });

  it("surfaces a second auth rejection without another query retry", async () => {
    const inner = new FakeBridge();
    inner.queryErrors.push(
      authenticationBlockedError(),
      authenticationBlockedError(),
    );
    let refreshes = 0;
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        refreshes += 1;
        return Promise.resolve("replacement-token");
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);

    await expect(query(bridge, context.signal)).rejects.toMatchObject({
      name: SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME,
    });

    expect(refreshes).toBe(1);
    expect(inner.queryCalls).toBe(2);

    inner.queryErrors.push(authenticationBlockedError());
    await expect(query(bridge, context.signal)).rejects.toMatchObject({
      name: SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME,
    });
    expect(refreshes).toBe(1);
    expect(inner.queryCalls).toBe(3);
  });

  it("continues root auth recovery after the query caller aborts", async () => {
    const inner = new FakeBridge();
    inner.queryErrors.push(authenticationBlockedError());
    const refresh = context.mocks.deferred<string | null>();
    let refreshes = 0;
    const bridge = new AuthRecoveringSharedDatabaseBridge(
      inner,
      () => {
        refreshes += 1;
        return refresh.promise;
      },
      context.signal,
    );
    await bridge.heartbeat(heartbeat(), context.signal);
    const caller = createChildAbortController(context.signal);

    const pending = query(bridge, caller.signal);
    await vi.waitFor(() => {
      expect(refreshes).toBe(1);
    });
    caller.abort(new DOMException("Query cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    refresh.resolve("replacement-token");
    await bridge.authenticationRequired();
    expect(inner.queryCalls).toBe(1);
    expect(
      inner.heartbeats.map((value) => {
        return value.token;
      }),
    ).toStrictEqual(["initial-token", "replacement-token"]);
  });
});
