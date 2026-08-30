import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuthOnAbort,
  mockClerkSessionSignedOut,
  mockOrganization,
  mockedClerk,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import {
  setupRealtime$,
  realtimeSubscriptionSnapshot$,
  setAblyLoop$,
  setAblyMessageLoop$,
  setAblyPayloadLoop$,
  subscribeRealtimeReadyCatchUp$,
} from "../realtime.ts";
import { initAuthRecovery$, initClerkRuntime$, setupClerk$ } from "../auth.ts";
import { foregroundReady$ } from "../auth-retry.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { subscribeChatThreadRealtime$ } from "../chat-page/chat-thread-remote-signals.ts";
import { testContext } from "./test-helpers.ts";
import { reloadFeatureSwitch$ } from "../external/feature-switch.ts";
import { now } from "../../lib/time.ts";
import { subscribePresentationTemplatesChanged$ } from "../okou-page/presentation-template-library.ts";

const context = testContext();

beforeEach(() => {
  context.store.set(setRootSignal$, context.signal);
  context.store.set(initClerkRuntime$, context.signal);
  context.store.set(initAuthRecovery$, context.signal);
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
  clearMockedAuthOnAbort(context.signal);
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

async function setupAuthAndRealtime(): Promise<void> {
  await context.store.set(setupClerk$, context.signal);
  await context.store.set(setupRealtime$, context.signal);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function testSubscriber(): AbortController {
  const controller = new AbortController();
  context.signal.addEventListener(
    "abort",
    () => {
      controller.abort(context.signal.reason);
    },
    { once: true },
  );
  return controller;
}

function abortListenerCallCount(calls: readonly unknown[][]): number {
  return calls.filter((call) => {
    return call[0] === "abort";
  }).length;
}

describe("realtime signals", () => {
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

  it("subscribes an org-scoped loop to the active organization channel", async () => {
    mockSignedInUser();
    const topic = "test:org-pending-resolve";
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return true;
    });

    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        scope: "org",
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );
    await context.store.set(setupRealtime$, context.signal);

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel("org:test-org-123", topic),
      ).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscriptionOnChannel("user:test-user-123", topic),
    ).toBeFalsy();
    context.mocks.ably.triggerOnChannel("org:test-org-123", topic);

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(1);
  });

  it("keeps workspace template realtime off while its feature switch is disabled", async () => {
    mockSignedInUser();
    const subscriber = testSubscriber();
    const subscriptionPromise = context.store.set(
      subscribePresentationTemplatesChanged$,
      subscriber.signal,
    );
    context.track(subscriptionPromise);

    await setupAuthAndRealtime();
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(
          "user:test-user-123",
          "presentationTemplatesChanged",
        ),
      ).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "org:test-org-123",
        "presentationTemplatesChanged",
      ),
    ).toBeFalsy();
  });

  it("removes and rejects a pending loop when the subscriber aborts", async () => {
    mockSignedInUser();
    const topic = "test:pending-abort";
    const subscriber = testSubscriber();

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
    const subscriber = testSubscriber();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      subscriber.signal,
    );
    context.track(loopPromise);
    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a payload subscription when abort races subscribe resolution", async () => {
    mockSignedInUser();
    const topic = "test:payload-subscribe-abort-race";
    const subscriber = testSubscriber();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
      },
      subscriber.signal,
    );
    context.track(loopPromise);
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
    const subscriber = testSubscriber();
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
    context.track(loopPromise);

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
  });

  it("keeps the initial realtime client when visible within the grace period", async () => {
    mockSignedInUser();
    const topic = "test:initially-hidden";
    const subscriber = testSubscriber();
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$ },
      subscriber.signal,
    );
    context.track(loopPromise);

    await setupAuthAndRealtime();
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(1);
    });
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("pauses subscriptions and resumes the same client within the grace period", async () => {
    mockSignedInUser();
    const topic = "test:visibility";
    const subscriber = testSubscriber();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
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
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(2);
    });
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalledWith({
      skipCache: true,
    });
  });

  it("closes realtime after the grace period and rebuilds when visible", async () => {
    mockSignedInUser();
    const topic = "test:visibility-close";
    const subscriber = testSubscriber();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$ },
      subscriber.signal,
    );
    context.track(loopPromise);
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
    await waitFor(() => {
      expect(
        context.store.get(realtimeSubscriptionSnapshot$).connectionState,
      ).toBe("closed");
    });

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(1);
    });
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("cancels stale close timers across repeated visibility changes", async () => {
    mockSignedInUser();
    const topic = "test:visibility-reset";
    const subscriber = testSubscriber();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: keepAliveLoop$ },
      subscriber.signal,
    );
    context.track(loopPromise);
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(
        context.store.get(realtimeSubscriptionSnapshot$).connectionState,
      ).toBe("connected");
    });
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
  });

  it("replays the final visible catch-up after an in-flight catch-up", async () => {
    mockSignedInUser();
    const topic = "test:visibility-in-flight";
    const subscriber = testSubscriber();
    const firstCatchUpStarted = context.mocks.deferred<void>();
    const firstCatchUpCanFinish = context.mocks.deferred<void>();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });
    let catchUps = 0;
    const holdFirstCatchUp$ = command(
      async (_ctx, signal: AbortSignal): Promise<void> => {
        catchUps += 1;
        if (catchUps !== 1) {
          return;
        }
        firstCatchUpStarted.resolve();
        await firstCatchUpCanFinish.promise;
        signal.throwIfAborted();
      },
    );

    await setupAuthAndRealtime();
    context.store.set(
      subscribeRealtimeReadyCatchUp$,
      holdFirstCatchUp$,
      subscriber.signal,
    );
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: keepAliveLoop$ },
      subscriber.signal,
    );
    context.track(loopPromise);
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await firstCatchUpStarted.promise;
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    const foregroundReady = context.store.get(foregroundReady$);
    expect(foregroundReady.pending).toBeTruthy();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    firstCatchUpCanFinish.resolve();
    await foregroundReady.promise;
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(catchUps).toBe(2);
      expect(context.store.get(foregroundReady$).pending).toBeFalsy();
    });
    expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(1);
  });

  it("keeps a foreground opt-out loop live and initially primed", async () => {
    mockSignedInUser();
    const topic = "test:foreground-opt-out";
    const subscriber = testSubscriber();
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
        options: {
          runOnForegroundCatchUp: false,
          runOnSubscribe: true,
        },
      },
      subscriber.signal,
    );
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(1);
    });

    window.dispatchEvent(new Event("focus"));
    const foregroundReady = await context.store.get(foregroundReady$);
    await foregroundReady.promise;
    expect(runs).toBe(1);
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();

    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(2);
    });
  });

  it("awaits resource catch-up after rebuilding the realtime client", async () => {
    mockSignedInUser();
    const topic = "test:ordered-resource-catch-up";
    const subscriber = testSubscriber();
    const catchUpCanFinish = context.mocks.deferred<void>();
    let catchUps = 0;
    let subscribedDuringCatchUp = false;
    const resourceCatchUp$ = command(
      async (_ctx, signal: AbortSignal): Promise<void> => {
        catchUps += 1;
        subscribedDuringCatchUp = context.mocks.ably.hasSubscription(topic);
        await catchUpCanFinish.promise;
        signal.throwIfAborted();
      },
    );

    await setupAuthAndRealtime();
    context.store.set(
      subscribeRealtimeReadyCatchUp$,
      resourceCatchUp$,
      subscriber.signal,
    );
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: keepAliveLoop$ },
      subscriber.signal,
    );
    context.track(loopPromise);
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    context.mocks.ably.triggerFailure("terminal connection failure");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(catchUps).toBe(1);
    });
    expect(subscribedDuringCatchUp).toBeTruthy();
    const foregroundReady = context.store.get(foregroundReady$);
    expect(foregroundReady.pending).toBeTruthy();

    catchUpCanFinish.resolve();
    await foregroundReady.promise;
    expect(context.store.get(foregroundReady$).pending).toBeFalsy();
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("removes aborted realtime-ready catch-up subscribers", async () => {
    mockSignedInUser();
    const subscriber = testSubscriber();
    let catchUps = 0;
    const resourceCatchUp$ = command((_ctx, _signal: AbortSignal) => {
      catchUps += 1;
    });

    await setupAuthAndRealtime();
    context.store.set(
      subscribeRealtimeReadyCatchUp$,
      resourceCatchUp$,
      subscriber.signal,
    );
    subscriber.abort();

    window.dispatchEvent(new Event("focus"));
    const foregroundReady = context.store.get(foregroundReady$);
    await foregroundReady.promise;
    expect(catchUps).toBe(0);
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("rebuilds a failed realtime client and pokes once", async () => {
    mockSignedInUser();
    const loopTopic = "test:failed-foreground-loop";
    const payloadTopic = "test:failed-foreground-payload";
    const subscriber = testSubscriber();
    const payloads: unknown[] = [];
    let loopRuns = 0;
    let payloadCatchUps = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      loopRuns += 1;
      return false;
    });
    const payloadLoop$ = command(
      (_ctx, payload: unknown, _signal: AbortSignal) => {
        payloads.push(payload);
        return false;
      },
    );
    const payloadCatchUp$ = command((_ctx, _signal: AbortSignal) => {
      payloadCatchUps += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic: loopTopic, loopCommand$: loop$ },
      subscriber.signal,
    );
    const payloadLoopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic: payloadTopic,
        loopCommand$: payloadLoop$,
        catchUpCommand$: payloadCatchUp$,
      },
      subscriber.signal,
    );
    context.track(loopPromise);
    context.track(payloadLoopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(loopTopic)).toBeTruthy();
      expect(context.mocks.ably.hasSubscription(payloadTopic)).toBeTruthy();
    });
    context.mocks.ably.trigger(loopTopic);
    context.mocks.ably.trigger(payloadTopic, { messageId: "before-failure" });
    await waitFor(() => {
      expect(loopRuns).toBe(1);
      expect(payloads).toStrictEqual([{ messageId: "before-failure" }]);
    });

    context.mocks.ably.triggerFailure("terminal connection failure");
    expect(context.mocks.ably.hasSubscription(loopTopic)).toBeFalsy();
    expect(context.mocks.ably.hasSubscription(payloadTopic)).toBeFalsy();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(loopTopic)).toBeTruthy();
      expect(context.mocks.ably.hasSubscription(payloadTopic)).toBeTruthy();
      expect(loopRuns).toBe(2);
      expect(payloadCatchUps).toBe(1);
    });

    context.mocks.ably.trigger(loopTopic);
    context.mocks.ably.trigger(payloadTopic, { messageId: "after-recovery" });
    await waitFor(() => {
      expect(loopRuns).toBe(3);
      expect(payloads).toStrictEqual([
        { messageId: "before-failure" },
        { messageId: "after-recovery" },
      ]);
    });
    expect(payloadCatchUps).toBe(1);
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("rebuilds a failed realtime client when the network comes back", async () => {
    mockSignedInUser();
    const topic = "test:failed-online-recovery";
    const subscriber = testSubscriber();
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$ },
      subscriber.signal,
    );
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.triggerFailure("terminal connection failure");
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    window.dispatchEvent(new Event("online"));

    await waitFor(() => {
      expect(context.mocks.ably.getAuthTokenHistory()).toHaveLength(2);
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(1);
    });
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
  });

  it("waits for the next foreground catch-up after rebuilding fails", async () => {
    mockSignedInUser();
    const topic = "test:failed-rebuild-retry";
    const subscriber = testSubscriber();
    const failedTokenCanRespond = context.mocks.deferred<void>();
    let tokenRequests = 0;
    context.mocks.api(
      platformRealtimeTokenContract.create,
      async ({ respond }) => {
        tokenRequests += 1;
        if (tokenRequests === 2) {
          await failedTokenCanRespond.promise;
          return respond(500, {
            error: {
              message: "realtime token unavailable",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }
        return respond(200, {
          keyName: "mock-key",
          clientId: "test-user-123",
          timestamp: now(),
          capability: '{"*":["*"]}',
          nonce: `mock-nonce-${tokenRequests}`,
          mac: "mock-mac",
        });
      },
    );
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$ },
      subscriber.signal,
    );
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    context.mocks.ably.triggerFailure("terminal connection failure");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(tokenRequests).toBe(2);
    });
    const foregroundReady = await context.store.get(foregroundReady$);
    expect(foregroundReady.pending).toBeTruthy();

    failedTokenCanRespond.resolve();
    await expect(foregroundReady.promise).rejects.toThrow(
      /Ably connection failed/,
    );
    expect(runs).toBe(1);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(tokenRequests).toBe(3);
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
      expect(runs).toBe(2);
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(3);
    });
  });

  it("does not consult Clerk before signed-out foreground catch-up", async () => {
    mockSignedInUser();
    const topic = "test:signed-out-visibility";
    const subscriber = testSubscriber();
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
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
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    mockClerkSessionSignedOut(true);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(runs).toBe(2);
    });

    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();
    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalledWith({
      skipCache: true,
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not block foreground catch-up on an in-flight 401 refresh", async () => {
    mockSignedInUser();
    const topic = "test:foreground-during-401";
    const subscriber = testSubscriber();
    const freshTokenCanFinish = context.mocks.deferred<string>();
    let requests = 0;
    let forcedTokenRefreshes = 0;
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
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
        return freshTokenCanFinish.promise;
      }
      return Promise.resolve("test-token");
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyLoop$,
      { topic, loopCommand$: loop$ },
      subscriber.signal,
    );
    context.track(loopPromise);
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    const responsePromise = context.store.set(
      reloadFeatureSwitch$,
      context.signal,
    );
    await waitFor(() => {
      expect(forcedTokenRefreshes).toBe(1);
    });

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(runs).toBe(2);
    });
    const foregroundReady = context.store.get(foregroundReady$);
    await foregroundReady.promise;
    expect(mockedClerk.sessionTouch).not.toHaveBeenCalled();

    freshTokenCanFinish.resolve("fresh-token");
    await responsePromise;
    expect(requests).toBe(2);
    expect(forcedTokenRefreshes).toBe(1);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
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
    const subscriber = testSubscriber();
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

    subscriber.abort(abortError("verify listener cleanup"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortListenerCallCount(removeListener.mock.calls),
    ).toBeGreaterThanOrEqual(abortListenerCallCount(addListener.mock.calls));
  });

  it("passes Ably payloads to payload loops", async () => {
    mockSignedInUser();
    const topic = "test:payload";
    const subscriber = testSubscriber();
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
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { threadId: "thread-1" });

    await waitFor(() => {
      expect(payloads).toStrictEqual([{ threadId: "thread-1" }]);
    });
  });

  it("uses catch-up commands for payload subscriptions and reconnects", async () => {
    mockSignedInUser();
    const topic = "test:payload-catch-up";
    const subscriber = testSubscriber();
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

    await setupAuthAndRealtime();
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
    context.track(loopPromise);

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
  });

  it("serializes user-channel messages received while the handler is in flight", async () => {
    mockSignedInUser();
    const subscriber = testSubscriber();
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

    subscriber.abort(abortError("verify subscription cleanup"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasChannelSubscription()).toBeFalsy();
  });

  it("runs user-channel catch-up on reconnect without a queued message", async () => {
    mockSignedInUser();
    const subscriber = testSubscriber();
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

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      {
        loopCommand$: loop$,
        catchUpCommand$: catchUp$,
      },
      subscriber.signal,
    );
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(catchUps).toBe(1);
    });
    expect(handledMessages).toStrictEqual([]);
  });

  it("waits for the next reconnect after user-channel catch-up fails", async () => {
    mockSignedInUser();
    const subscriber = testSubscriber();
    const handledMessages: unknown[] = [];
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    let catchUps = 0;
    const loop$ = command(
      (_ctx, message: unknown, _signal: AbortSignal): boolean => {
        handledMessages.push(message);
        return false;
      },
    );
    const catchUp$ = command((_ctx, _signal: AbortSignal): boolean => {
      catchUps += 1;
      if (catchUps === 1) {
        throw new Error("catch-up failed");
      }
      return false;
    });

    await setupAuthAndRealtime();
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      {
        loopCommand$: loop$,
        catchUpCommand$: catchUp$,
      },
      subscriber.signal,
    );
    context.track(loopPromise);

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1);
    });
    expect(catchUps).toBe(1);

    context.mocks.ably.trigger("chatThreadMessageCreated:thread-1");
    await waitFor(() => {
      expect(handledMessages).toHaveLength(1);
    });

    context.mocks.ably.triggerReconnect();
    await waitFor(() => {
      expect(catchUps).toBe(2);
    });
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
