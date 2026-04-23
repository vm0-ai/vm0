import { describe, it, expect, vi, afterEach } from "vitest";
import { command, createStore } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core/contracts/realtime";
import { setAblyLoop$, setupRealtime$ } from "../realtime.ts";
import { clearAllDetached } from "../utils.ts";
import {
  triggerAblyEvent,
  triggerAblyReconnect,
  triggerAblyReauth,
  getAuthTokenHistory,
  resetAblySubscriptions,
  hasSubscription,
} from "../../mocks/ably.ts";
import { server } from "../../mocks/server.ts";
import { apiRealtimeHandlers } from "../../mocks/handlers/api-realtime.ts";
import { mockApi } from "../../mocks/msw-contract.ts";
import { mockUser, clearMockedAuth } from "../../__tests__/mock-auth.ts";

// ---------------------------------------------------------------------------
// setAblyLoop$ with mock Ably channel
// ---------------------------------------------------------------------------

function setupTestStore() {
  const store = createStore();
  const controller = new AbortController();

  server.use(...apiRealtimeHandlers);
  mockUser(
    { id: "test-user-123", fullName: "Test User" },
    { token: "test-token" },
  );

  return { store, controller };
}

afterEach(() => {
  resetAblySubscriptions();
  clearMockedAuth();
});

describe("setAblyLoop$ with mock Ably", () => {
  it("resolves when loopCommand$ returns true on first call", async () => {
    const { store, controller } = setupTestStore();

    await store.set(setupRealtime$, controller.signal);

    const body = vi.fn().mockReturnValue(true);
    const loopCommand$ = command((_store, _signal: AbortSignal) => {
      return body() as boolean;
    });

    await store.set(setAblyLoop$, "topic", loopCommand$, controller.signal);

    expect(body).toHaveBeenCalledOnce();
    controller.abort();
  });

  it("iterates when triggerAblyEvent fires, resolves when body returns true", async () => {
    const { store, controller } = setupTestStore();

    await store.set(setupRealtime$, controller.signal);

    let calls = 0;
    const loopCommand$ = command((_store, _signal: AbortSignal) => {
      calls++;
      return calls >= 3;
    });

    const loopPromise = store.set(
      setAblyLoop$,
      "test-topic",
      loopCommand$,
      controller.signal,
    );

    // First call happens immediately inside setAblyLoop$ (calls === 1), then
    // the loop subscribes and waits on deferred.promise. Match real Ably
    // semantics: don't fire server-side events until the subscription is
    // confirmed — otherwise events arrive before the callback is registered
    // and get dropped on the floor.
    await vi.waitFor(() => {
      expect(calls).toBe(1);
      expect(hasSubscription("test-topic")).toBeTruthy();
    });

    triggerAblyEvent("test-topic"); // calls === 2, returns false → loop continues
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });

    triggerAblyEvent("test-topic"); // calls === 3, returns true → loop resolves
    await loopPromise;

    expect(calls).toBe(3);
    controller.abort();
  });

  it("pokes every active subscriber on reconnect", async () => {
    const { store, controller } = setupTestStore();

    await store.set(setupRealtime$, controller.signal);

    let callsA = 0;
    let callsB = 0;
    const loopA$ = command((_store, _signal: AbortSignal) => {
      callsA++;
      return false;
    });
    const loopB$ = command((_store, _signal: AbortSignal) => {
      callsB++;
      return false;
    });

    const loopAPromise = store.set(
      setAblyLoop$,
      "topic-a",
      loopA$,
      controller.signal,
    );
    const loopBPromise = store.set(
      setAblyLoop$,
      "topic-b",
      loopB$,
      controller.signal,
    );

    // Wait for both loops' first iteration + subscription registration.
    await vi.waitFor(() => {
      expect(callsA).toBe(1);
      expect(callsB).toBe(1);
      expect(hasSubscription("topic-a")).toBeTruthy();
      expect(hasSubscription("topic-b")).toBeTruthy();
    });

    triggerAblyReconnect();

    // Each subscriber gets poked once → each loop body runs again.
    await vi.waitFor(() => {
      expect(callsA).toBe(2);
      expect(callsB).toBe(2);
    });

    controller.abort();
    await expect(loopAPromise).rejects.toThrow();
    await expect(loopBPromise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// setupRealtime$ authCallback freshness (regression for #10163)
// ---------------------------------------------------------------------------

describe("setupRealtime$ authCallback", () => {
  it("fetches a fresh TokenRequest on every invocation", async () => {
    const store = createStore();
    const controller = new AbortController();

    // Issue a distinct nonce per POST so freshness is observable.
    let nonceCounter = 0;
    server.use(
      mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
        nonceCounter += 1;
        return respond(200, {
          keyName: "mock-key",
          clientId: "test-user-123",
          timestamp: Date.now(),
          capability: '{"*":["*"]}',
          nonce: `mock-nonce-${nonceCounter}`,
          mac: "mock-mac",
        });
      }),
    );
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );

    await store.set(setupRealtime$, controller.signal);

    const firstHistory = getAuthTokenHistory();
    expect(firstHistory).toHaveLength(1);
    const firstBody = firstHistory[0];

    // Simulate Ably proactively renewing the token after ttl elapses.
    await triggerAblyReauth();

    const secondHistory = getAuthTokenHistory();
    expect(secondHistory).toHaveLength(2);
    // The pre-fix cached-closure implementation returned the same body both
    // times; a distinct body per invocation is the real freshness signal.
    expect(secondHistory[1]).not.toStrictEqual(firstBody);

    controller.abort();
  });

  it("skips auth forwarding when signal aborts mid-flight", async () => {
    const store = createStore();
    const controller = new AbortController();
    server.use(...apiRealtimeHandlers);
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );

    await store.set(setupRealtime$, controller.signal);

    // Teardown sequence: setupRealtime$'s abort listener fires ably.close.
    // Any in-flight authCallback fetch is collateral — its AbortError
    // must not surface to Ably's callback as a spurious "failed" event.
    controller.abort();

    // With the abort guard in place, the authCallback short-circuits in
    // its catch branch and Ably's callback is never invoked — the mock's
    // invokeAuthCallback promise then stays pending. Without the guard,
    // the AbortError would be forwarded and the promise would reject.
    let reauthOutcome: "pending" | "resolved" | "rejected" = "pending";
    triggerAblyReauth()
      .then(() => {
        reauthOutcome = "resolved";
      })
      .catch(() => {
        reauthOutcome = "rejected";
      });

    // Await the detach'd IIFE inside the authCallback, then drain a few
    // microtasks so any resolution propagates through the mock.
    await clearAllDetached();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(reauthOutcome).toBe("pending");
  });

  it("forwards endpoint errors to ably's callback on renewal", async () => {
    const store = createStore();
    const controller = new AbortController();

    // First two calls succeed (bootstrap probe + initial auth). The third
    // — standing in for Ably's proactive renewal — returns 500 so we can
    // assert the authCallback's error path is wired up correctly.
    let call = 0;
    server.use(
      mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
        call += 1;
        if (call >= 3) {
          return respond(500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Realtime service unavailable",
            },
          });
        }
        return respond(200, {
          keyName: "mock-key",
          clientId: "test-user-123",
          timestamp: Date.now(),
          capability: '{"*":["*"]}',
          nonce: `mock-nonce-${call.toString()}`,
          mac: "mock-mac",
        });
      }),
    );
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );

    await store.set(setupRealtime$, controller.signal);

    await expect(triggerAblyReauth()).rejects.toThrow(
      "Realtime service unavailable",
    );

    controller.abort();
  });
});
