import { describe, it, expect, vi, afterEach } from "vitest";
import { command, createStore } from "ccstate";
import { setAblyLoop$, setupRealtime$ } from "../realtime.ts";
import {
  triggerAblyEvent,
  triggerAblyReconnect,
  resetAblySubscriptions,
  hasSubscription,
} from "../../mocks/ably.ts";
import { server } from "../../mocks/server.ts";
import { apiRealtimeHandlers } from "../../mocks/handlers/api-realtime.ts";
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
