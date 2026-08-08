import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockedClerk,
  mockedClerkLoad,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import {
  setupRealtime$,
  setAblyLoop$,
  setAblyMessageLoop$,
  setAblyPayloadLoop$,
} from "../realtime.ts";
import { setupClerk$ } from "../auth.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { subscribeChatThreadRealtime$ } from "../chat-page/chat-thread-remote-signals.ts";
import { testContext } from "./test-helpers.ts";
import {
  foregroundAuthRecoveryEnabled$,
  setFeatureSwitchLocalStorage$,
} from "../external/feature-switch-state.ts";
import { reloadFeatureSwitch$ } from "../external/feature-switch.ts";

const context = testContext();

const setForegroundAuthRecovery$ = command(({ set }, enabled: boolean) => {
  set(
    setFeatureSwitchLocalStorage$,
    JSON.stringify(
      getAllFeatureStates({
        overrides: { [FeatureSwitchKey.ForegroundAuthRecovery]: enabled },
      }),
    ),
  );
});

const setMissingForegroundAuthRecovery$ = command(({ set }) => {
  set(
    setFeatureSwitchLocalStorage$,
    JSON.stringify({
      ...getAllFeatureStates({}),
      [FeatureSwitchKey.ForegroundAuthRecovery]: undefined,
    }),
  );
});

const finishLoop$ = command((_ctx, _signal: AbortSignal) => {
  return true;
});

const keepAliveLoop$ = command((_ctx, _signal: AbortSignal) => {
  return Promise.resolve(false);
});

const keepAlivePayloadLoop$ = command(
  (_ctx, _payload: unknown, _signal: AbortSignal) => {
    return false;
  },
);

const failReadyCatchup$ = command((_ctx, _signal: AbortSignal) => {
  throw new Error("ready catch-up failed");
});

function mockSignedInUser(): void {
  mockUser(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
  mockOrganization({
    activeOrg: { id: "test-org-123", name: "Test Organization" },
    memberships: [{ id: "test-org-123" }],
  });
}

function setForegroundAuthRecovery(enabled: boolean): void {
  context.store.set(setForegroundAuthRecovery$, enabled);
}

async function setupAuthAndRealtime(): Promise<void> {
  await context.store.set(setupClerk$, context.signal);
  await context.store.set(setupRealtime$, context.signal);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function abortListenerCallCount(calls: readonly unknown[][]): number {
  return calls.filter((call) => {
    return call[0] === "abort";
  }).length;
}

describe("realtime signals", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("resolves a pending loop after realtime setup connects", async () => {
    mockSignedInUser();
    const topic = "test:pending-resolve";
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return true;
    });

    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    await context.store.set(setupRealtime$, context.signal);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(1);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("removes and rejects a pending loop when the subscriber aborts", async () => {
    mockSignedInUser();
    const topic = "test:pending-abort";
    const subscriber = new AbortController();

    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      subscriber.signal,
    );

    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    await context.store.set(setupRealtime$, context.signal);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("rejects pending loops when realtime auth fails", async () => {
    mockSignedInUser();
    context.mocks.api(platformRealtimeTokenContract.create, ({ respond }) => {
      return respond(500, {
        error: {
          message: "realtime token unavailable",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    const topic = "test:auth-failure";
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      context.signal,
    );
    const setupPromise = context.store.set(setupRealtime$, context.signal);

    await expect(setupPromise).rejects.toThrow(/Ably connection failed/);
    await expect(loopPromise).rejects.toThrow(/Ably connection failed/);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a loop subscription when abort races subscribe resolution", async () => {
    mockSignedInUser();
    const topic = "test:subscribe-abort-race";
    const subscriber = new AbortController();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      subscriber.signal,
    );
    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a payload subscription when abort races subscribe resolution", async () => {
    mockSignedInUser();
    const topic = "test:payload-subscribe-abort-race";
    const subscriber = new AbortController();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
      },
      subscriber.signal,
    );
    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("propagates a payload channel attach failure", async () => {
    mockSignedInUser();
    const topic = "test:payload-subscribe-failure";

    await context.store.set(setupRealtime$, context.signal);
    context.mocks.ably.rejectNextSubscribe("channel attach failed");

    await expect(
      context.store.set(
        setAblyPayloadLoop$,
        {
          topic,
          loopCommand$: keepAlivePayloadLoop$,
        },
        context.signal,
      ),
    ).rejects.toThrow("channel attach failed");
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("reruns an active loop on reconnect", async () => {
    mockSignedInUser();
    const topic = "test:reconnect";
    const subscriber = new AbortController();
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    context.mocks.ably.triggerReconnect();
    await waitFor(() => {
      expect(runs).toBe(2);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses hydrated rollout state when the initial cache is missing the key", async () => {
    mockSignedInUser();
    mockOrganization({
      activeOrg: { id: "staff-org-123", name: "Staff Organization" },
      memberships: [{ id: "staff-org-123" }],
    });
    context.store.set(setMissingForegroundAuthRecovery$);
    const topic = "test:visibility-disabled";
    const subscriber = new AbortController();
    const touchCanFinish = context.mocks.deferred<void>();
    mockedClerk.sessionTouch.mockReturnValue(touchCanFinish.promise);
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    expect(context.store.get(foregroundAuthRecoveryEnabled$)).toBeFalsy();
    setForegroundAuthRecovery(true);
    expect(context.store.get(foregroundAuthRecoveryEnabled$)).toBeTruthy();
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(mockedClerk.sessionTouch).toHaveBeenCalledTimes(1);
    });
    expect(runs).toBe(1);
    expect(mockedClerkLoad).toHaveBeenCalledWith(
      expect.objectContaining({ touchSession: false }),
    );

    touchCanFinish.resolve();
    await waitFor(() => {
      expect(runs).toBe(2);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses refreshed external-org state after a stale staff cache loaded Clerk", async () => {
    mockSignedInUser();
    mockOrganization({
      activeOrg: { id: "external-org-123", name: "External Organization" },
      memberships: [{ id: "external-org-123" }],
    });
    setForegroundAuthRecovery(true);
    const topic = "test:visibility-stale-enabled-cache";
    const subscriber = new AbortController();
    const touchCanFinish = context.mocks.deferred<void>();
    mockedClerk.sessionTouch.mockReturnValue(touchCanFinish.promise);
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    expect(context.store.get(foregroundAuthRecoveryEnabled$)).toBeTruthy();
    setForegroundAuthRecovery(false);
    expect(context.store.get(foregroundAuthRecoveryEnabled$)).toBeFalsy();
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(runs).toBe(2);
    });
    expect(mockedClerk.sessionTouch).toHaveBeenCalledTimes(1);
    expect(mockedClerkLoad).toHaveBeenCalledWith(
      expect.objectContaining({ touchSession: false }),
    );

    touchCanFinish.resolve();
    await waitFor(() => {
      expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
        skipCache: true,
      });
    });
    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for one foreground auth recovery before rerunning an active loop", async () => {
    mockSignedInUser();
    setForegroundAuthRecovery(true);
    const topic = "test:visibility";
    const subscriber = new AbortController();
    const touchCanFinish = context.mocks.deferred<void>();
    mockedClerk.sessionTouch.mockReturnValue(touchCanFinish.promise);
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    expect(document.visibilityState).toBe("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(mockedClerk.sessionTouch).toHaveBeenCalledTimes(1);
    });
    expect(runs).toBe(1);

    touchCanFinish.resolve();
    await waitFor(() => {
      expect(runs).toBe(2);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("shares an in-flight foreground recovery with a concurrent 401", async () => {
    mockSignedInUser();
    setForegroundAuthRecovery(true);
    context.store.set(setRootSignal$, context.signal);
    const touchCanFinish = context.mocks.deferred<void>();
    mockedClerk.sessionTouch.mockReturnValue(touchCanFinish.promise);
    let requests = 0;
    let forcedTokenRefreshes = 0;
    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      requests += 1;
      if (requests === 1) {
        return respond(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          },
        });
      }
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      if (options?.skipCache) {
        forcedTokenRefreshes += 1;
        return Promise.resolve("fresh-token");
      }
      return Promise.resolve("test-token");
    });

    await setupAuthAndRealtime();
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(mockedClerk.sessionTouch).toHaveBeenCalledTimes(1);
    });

    const responsePromise = context.store.set(
      reloadFeatureSwitch$,
      context.signal,
    );
    await waitFor(() => {
      expect(requests).toBe(1);
    });
    expect(forcedTokenRefreshes).toBe(0);

    touchCanFinish.resolve();
    await responsePromise;
    expect(requests).toBe(2);
    expect(forcedTokenRefreshes).toBe(2);
    expect(mockedClerk.sessionTouch).toHaveBeenCalledTimes(1);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("retries Clerk-wrapped foreground network failures before catch-up", async () => {
    mockSignedInUser();
    setForegroundAuthRecovery(true);
    const topic = "test:visibility-network-retry";
    const subscriber = new AbortController();
    let touchAttempts = 0;
    mockedClerk.sessionTouch.mockImplementation(() => {
      touchAttempts += 1;
      if (touchAttempts === 1) {
        return Promise.reject(
          new Error(
            'ClerkJS: Network error at "https://clerk.example.test/touch" - TypeError: Load failed',
          ),
        );
      }
      return Promise.resolve();
    });
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(runs).toBe(2);
    });
    expect(touchAttempts).toBe(2);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reruns a loop for a notification received while the handler is in flight", async () => {
    mockSignedInUser();
    const topic = "test:in-flight-notification";
    const firstRunCanFinish = context.mocks.deferred<void>();
    let runs = 0;
    const loop$ = command(async (_ctx, signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        await firstRunCanFinish.promise;
        signal.throwIfAborted();
        return false;
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    context.mocks.ably.trigger(topic);
    firstRunCanFinish.resolve();

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("retries an active loop after a transient handler error", async () => {
    mockSignedInUser();
    const topic = "test:transient-loop-error";
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        throw new Error("temporary loop failure");
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("removes settled realtime wait abort listeners between notifications", async () => {
    mockSignedInUser();
    const topic = "test:listener-cleanup";
    const subscriber = new AbortController();
    const addListener = vi.spyOn(subscriber.signal, "addEventListener");
    const removeListener = vi.spyOn(subscriber.signal, "removeEventListener");
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    const removesAfterSubscribe = abortListenerCallCount(
      removeListener.mock.calls,
    );

    for (let i = 0; i < 5; i++) {
      context.mocks.ably.trigger(topic);
      await waitFor(() => {
        expect(runs).toBe(i + 1);
      });
    }

    expect(
      abortListenerCallCount(removeListener.mock.calls),
    ).toBeGreaterThanOrEqual(removesAfterSubscribe + 5);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortListenerCallCount(removeListener.mock.calls),
    ).toBeGreaterThanOrEqual(abortListenerCallCount(addListener.mock.calls));
  });

  it("passes Ably payloads to payload loops", async () => {
    mockSignedInUser();
    const topic = "test:payload";
    const subscriber = new AbortController();
    const payloads: unknown[] = [];
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      payloads.push(payload);
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { threadId: "thread-1" });

    await waitFor(() => {
      expect(payloads).toStrictEqual([{ threadId: "thread-1" }]);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses catch-up commands for payload subscriptions and reconnects", async () => {
    mockSignedInUser();
    const topic = "test:payload-catch-up";
    const subscriber = new AbortController();
    const payloads: unknown[] = [];
    let catchUps = 0;
    const loop$ = command(
      (_ctx, payload: unknown, _signal: AbortSignal): boolean => {
        payloads.push(payload);
        return false;
      },
    );
    const catchUp$ = command((_ctx, _signal: AbortSignal): boolean => {
      catchUps += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
        catchUpCommand$: catchUp$,
        options: { runOnSubscribe: true },
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(catchUps).toBe(1);
    });
    context.mocks.ably.trigger(topic, { connectorSlug: "gmail" });
    await waitFor(() => {
      expect(payloads).toStrictEqual([{ connectorSlug: "gmail" }]);
    });

    context.mocks.ably.triggerReconnect();
    await waitFor(() => {
      expect(catchUps).toBe(2);
    });
    expect(payloads).toStrictEqual([{ connectorSlug: "gmail" }]);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("serializes user-channel messages received while the handler is in flight", async () => {
    mockSignedInUser();
    const subscriber = new AbortController();
    const firstRunCanFinish = context.mocks.deferred<void>();
    const handledNames: (string | undefined)[] = [];
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    const loop$ = command(
      async (_ctx, message: unknown, signal: AbortSignal): Promise<boolean> => {
        activeHandlers += 1;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        handledNames.push(
          typeof message === "object" &&
            message !== null &&
            "name" in message &&
            typeof message.name === "string"
            ? message.name
            : undefined,
        );
        if (handledNames.length === 1) {
          await firstRunCanFinish.promise;
          signal.throwIfAborted();
        }
        activeHandlers -= 1;
        return false;
      },
    );

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      { loopCommand$: loop$ },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.trigger("chatThreadMessageCreated:thread-1");
    await waitFor(() => {
      expect(handledNames).toStrictEqual(["chatThreadMessageCreated:thread-1"]);
    });

    context.mocks.ably.trigger("chatThreadMessageCreated:thread-2");
    expect(handledNames).toStrictEqual(["chatThreadMessageCreated:thread-1"]);
    firstRunCanFinish.resolve();

    await waitFor(() => {
      expect(handledNames).toStrictEqual([
        "chatThreadMessageCreated:thread-1",
        "chatThreadMessageCreated:thread-2",
      ]);
    });
    expect(maxActiveHandlers).toBe(1);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasChannelSubscription()).toBeFalsy();
  });

  it("runs user-channel catch-up on reconnect without a queued message", async () => {
    mockSignedInUser();
    const subscriber = new AbortController();
    const handledMessages: unknown[] = [];
    let catchUps = 0;
    const loop$ = command(
      (_ctx, message: unknown, _signal: AbortSignal): boolean => {
        handledMessages.push(message);
        return false;
      },
    );
    const catchUp$ = command((_ctx, _signal: AbortSignal): boolean => {
      catchUps += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      {
        loopCommand$: loop$,
        catchUpCommand$: catchUp$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(catchUps).toBe(1);
    });
    expect(handledMessages).toStrictEqual([]);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a payload notification after a transient handler error", async () => {
    mockSignedInUser();
    const topic = "test:transient-payload-error";
    const payloads: unknown[] = [];
    let runs = 0;
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        throw new Error("temporary payload failure");
      }
      payloads.push(payload);
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { messageId: "message-1" });

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
    expect(payloads).toStrictEqual([{ messageId: "message-1" }]);
  });

  it("drops a payload after repeated handler failures and processes later payloads", async () => {
    mockSignedInUser();
    const topic = "test:poison-payload";
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    const handled: unknown[] = [];
    let poisonAttempts = 0;
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "poison" in payload
      ) {
        poisonAttempts += 1;
        throw new Error("permanent payload failure");
      }
      handled.push(payload);
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { poison: "first" });
    context.mocks.ably.trigger(topic, { poison: "second" });
    context.mocks.ably.trigger(topic, { messageId: "message-1" });

    await expect(loopPromise).resolves.toBeUndefined();
    expect(poisonAttempts).toBe(8);
    expect(handled).toStrictEqual([{ messageId: "message-1" }]);
    expect(toastError).toHaveBeenCalledTimes(1);
    toastError.mockRestore();
  });

  it("stops retrying a failing notification handler until the next poke", async () => {
    mockSignedInUser();
    const topic = "test:poison-notification";
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      if (runs <= 4) {
        throw new Error("permanent notification failure");
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1);
    });
    expect(runs).toBe(4);

    context.mocks.ably.trigger(topic);
    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(5);
    toastError.mockRestore();
  });

  it("propagates ready catch-up failures without aborting subscriptions", async () => {
    mockSignedInUser();
    const threadId = "test-thread-ready-catchup-failure";
    await context.store.set(setupRealtime$, context.signal);

    await expect(
      context.store.set(
        subscribeChatThreadRealtime$,
        {
          threadId,
          handlers: {
            onThreadDetailChanged$: keepAliveLoop$,
            onAutomationsChanged$: keepAliveLoop$,
            onArtifactsChanged$: keepAliveLoop$,
            onWorkflowsChanged$: keepAliveLoop$,
            onSubscribed$: failReadyCatchup$,
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("ready catch-up failed");

    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadAutomationsChanged:${threadId}`,
      ),
    ).toBeTruthy();
  });
});
