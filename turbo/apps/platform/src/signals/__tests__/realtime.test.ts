import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { beforeEach, expect, test, vi } from "vitest";

import { mockedClerk } from "../../__tests__/mock-auth.ts";
import {
  setupRealtime$,
  realtimeSubscriptionSnapshot$,
  setAblyLoop$,
  setAblyPayloadLoop$,
  setRealtimeDegradedNotifier$,
  subscribeRealtimeReadyCatchUp$,
} from "../realtime.ts";
import { clerk$, setupClerk$ } from "../auth.ts";
import { initializeAppVersion$ } from "../app-version.ts";
import { foregroundReady$ } from "../foreground-catch-up.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { setApiClientRuntime$ } from "../api-client-runtime.ts";
import { setAuthenticatedIdentity$ } from "../auth-context.ts";
import { subscribeChatThreadRealtime$ } from "../chat-page/chat-thread-remote-signals.ts";
import { testContext } from "./test-helpers.ts";
import { now } from "../../lib/time.ts";
import { subscribePresentationTemplatesChanged$ } from "../okou-page/presentation-template-library.ts";
import { detach, Reason } from "../utils.ts";

const context = testContext();

beforeEach(() => {
  context.mocks.clerk();
  context.store.set(initializeAppVersion$, __OKOU_APP_VERSION__);
  context.store.set(setRootSignal$, context.signal);
  context.store.set(setApiClientRuntime$, {
    environment: "app",
    apiBaseUrl: location.origin,
    oauthApiBaseUrl: location.origin,
    clerk: context.store.get(clerk$),
  });
  context.store.set(setRealtimeDegradedNotifier$, () => {
    toast.error("Realtime connection degraded");
  });
});

const finishLoop$ = command((_ctx, _signal: AbortSignal) => {
  return true;
});

const keepAliveLoop$ = command((_ctx, _signal: AbortSignal) => {
  return Promise.resolve(false);
});

const failReadyCatchup$ = command((_ctx, _signal: AbortSignal) => {
  throw new Error("ready catch-up failed");
});

function mockSignedInUser(): void {
  const clerk = context.mocks.clerk();
  clerk.user(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
  clerk.organization({
    activeOrg: { id: "test-org-123", name: "Test Organization" },
    memberships: [{ id: "test-org-123" }],
  });
  context.store.set(
    setAuthenticatedIdentity$,
    Promise.resolve({
      userId: "test-user-123",
      orgId: "test-org-123",
      email: "test@example.com",
    }),
  );
}

async function setupAuthAndRealtime(): Promise<void> {
  await context.store.set(setupClerk$, context.signal);
  await context.store.set(setupRealtime$, context.signal);
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

test("A pending live-update listener starts after realtime connects", async () => {
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

test("Workspace live updates stay in the active workspace", async () => {
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

test("A disabled workspace-template feature does not receive workspace updates", async () => {
  mockSignedInUser();
  const subscriber = testSubscriber();
  const subscriptionPromise = context.store.set(
    subscribePresentationTemplatesChanged$,
    subscriber.signal,
  );
  detach(subscriptionPromise, Reason.Daemon, "test realtime subscription");

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

test("Realtime authentication failure does not leave stale live updates", async () => {
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

test("Reconnecting catches up active resources", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");

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

test("A short background period pauses and resumes live updates efficiently", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(1);
  });

  visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => {
    expect(context.store.get(foregroundReady$).pending).toBeTruthy();
  });
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

test("A long background period rebuilds the live connection", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  context.mocks.ably.triggerConnectionClosed();
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

test("Rapid tab switching keeps one current live connection", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");
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

test("The latest return to a tab gets a final catch-up", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => {
    expect(context.store.get(foregroundReady$).pending).toBeTruthy();
  });

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
  await waitFor(() => {
    expect(context.store.get(foregroundReady$).pending).toBeTruthy();
  });
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

test("Foreground readiness waits for resource catch-up", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");
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

test("A failed live connection recovers on focus or network return", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");
  detach(payloadLoopPromise, Reason.Daemon, "test realtime payload loop");

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

test("A failed realtime rebuild retries on the next foreground opportunity", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");

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
  const foregroundReady = context.store.get(foregroundReady$);
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

test("A signed-out foreground return does not show authentication noise", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");

  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  context.mocks.ably.trigger(topic);
  await waitFor(() => {
    expect(runs).toBe(1);
  });

  context.mocks.clerk().sessionSignedOut(true);
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

test("An update arriving during processing is not lost", async () => {
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

test("A transient live-update error is retried", async () => {
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

test("Payload updates and reconnect catch-up work together", async () => {
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
  detach(loopPromise, Reason.Daemon, "test realtime loop");

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

test("A permanently bad live update does not block later updates", async () => {
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

test("A persistent refresh error pauses until a new update", async () => {
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

test("A catch-up failure does not destroy live subscriptions", async () => {
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
