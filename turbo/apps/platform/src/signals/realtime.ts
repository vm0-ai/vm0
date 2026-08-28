import { command, computed, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import type {
  ChannelStateChange,
  ConnectionStateChange,
  InboundMessage,
  RealtimeChannel,
} from "ably";
import { toast } from "@okouai/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { createAblyRealtime, type AblyRealtime } from "../lib/ably-realtime.ts";
import { now } from "../lib/time.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedIdentity$ } from "./auth.ts";
import {
  requestForegroundCatchUp$,
  subscribeForegroundCatchUp$,
} from "./auth-retry.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import {
  connectionDiagnosticError,
  createConnectionDiagnosticSpanId,
  publishConnectionDiagnostic,
  type ConnectionDiagnosticDetails,
} from "./connection-diagnostics.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  onRejection,
  resetSignal,
  settle,
  setLoop,
  throwIfAbort,
  withCleanup,
} from "./utils.ts";
import { logger } from "./log.ts";
import { i18n } from "../i18n/index.ts";

const L = logger("Realtime");
const REALTIME_TRANSIENT_RETRY_DELAYS_MS = [
  1000, 2000, 5000, 10_000, 30_000,
] as const;
const MAX_TRANSIENT_RETRIES = 3;
const REALTIME_BACKGROUND_CLOSE_GRACE_MS = 15_000;
const realtimeBackgroundCloseDelayMs = IN_VITEST
  ? 0
  : REALTIME_BACKGROUND_CLOSE_GRACE_MS;

function isDocumentVisible(): boolean {
  return document.visibilityState === "visible";
}

type RealtimeConnectionState = ConnectionStateChange["current"];
type RealtimeChannelState = ChannelStateChange["current"];

function connectionStateDetails(
  stateChange: ConnectionStateChange,
): ConnectionDiagnosticDetails {
  const errorDetails = connectionDiagnosticError(stateChange.reason);
  return {
    ...errorDetails,
    connectionState: stateChange.current,
    previousConnectionState: stateChange.previous,
    retryInMs:
      typeof stateChange.retryIn === "number"
        ? stateChange.retryIn
        : errorDetails.retryInMs,
  };
}

function channelStateDetails(
  stateChange: ChannelStateChange,
): ConnectionDiagnosticDetails {
  return {
    ...connectionDiagnosticError(stateChange.reason),
    channelState: stateChange.current,
    previousChannelState: stateChange.previous,
  };
}

const realtimeDegradedToastShown$ = state(false);

const notifyRealtimeDegraded$ = command(({ get, set }) => {
  if (get(realtimeDegradedToastShown$)) {
    return;
  }
  set(realtimeDegradedToastShown$, true);
  toast.error(
    i18n.t(($) => {
      return $.global.realtime.degraded;
    }),
  );
});

type ChannelCallback = (message: InboundMessage) => void;

interface StableRealtimeChannel {
  readonly state: () => RealtimeChannelState | null;
  readonly subscribe: (
    topic: string | null,
    callback: ChannelCallback,
  ) => Promise<unknown>;
  readonly unsubscribe: (
    topic: string | null,
    callback: ChannelCallback,
  ) => void;
  readonly pauseSubscriptions: () => void;
  readonly resumeSubscriptions: () => Promise<void>;
  readonly suspend: () => void;
  readonly replace: (channel: RealtimeChannel) => Promise<void>;
}

interface RealtimeSession {
  readonly ably: AblyRealtime;
  readonly channels: RealtimeSessionChannels;
  readonly close: () => void;
}

type RealtimeChannelScope = "user" | "org";

interface RealtimeSessionChannels {
  readonly user: StableRealtimeChannel;
  readonly org: StableRealtimeChannel;
}

const internalRealtimeSession$ = state<RealtimeSession | null>(null);
const realtimeStateRevision$ = state(0);

interface RealtimeSubscriptionSnapshot {
  readonly channelState: RealtimeChannelState | null;
  readonly connectionState: RealtimeConnectionState | null;
}

export const realtimeSubscriptionSnapshot$ = computed(
  (get): RealtimeSubscriptionSnapshot => {
    get(realtimeStateRevision$);
    const session = get(internalRealtimeSession$);
    return {
      channelState: session?.channels.user.state() ?? null,
      connectionState: session?.ably.connection.state ?? null,
    };
  },
);

const subscriberPokeTarget$ = state(new EventTarget());
const SUBSCRIBER_POKE_EVENT = "poke";
type RealtimeReadyCatchUpCommand = Command<Promise<void> | void, [AbortSignal]>;
const realtimeReadyCatchUpCommands$ = state<
  ReadonlySet<RealtimeReadyCatchUpCommand>
>(new Set());

/**
 * Register snapshot catch-up that runs after realtime recovery and before the
 * shared foreground-ready barrier resolves.
 */
export const subscribeRealtimeReadyCatchUp$ = command(
  (
    { get, set },
    callback$: RealtimeReadyCatchUpCommand,
    signal: AbortSignal,
  ) => {
    set(
      realtimeReadyCatchUpCommands$,
      new Set([...get(realtimeReadyCatchUpCommands$), callback$]),
    );
    signal.addEventListener(
      "abort",
      () => {
        const commands = new Set(get(realtimeReadyCatchUpCommands$));
        commands.delete(callback$);
        set(realtimeReadyCatchUpCommands$, commands);
      },
      { once: true },
    );
  },
);

const runRealtimeReadyCatchUp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await Promise.all(
      [...get(realtimeReadyCatchUpCommands$)].map(async (callback$) => {
        await set(callback$, signal);
        signal.throwIfAborted();
      }),
    );
    signal.throwIfAborted();
  },
);

interface PendingAblySubscription {
  readonly scope: RealtimeChannelScope;
  topic: string;
  signal: AbortSignal;
  channelDeferred: ReturnType<
    typeof createDeferredPromise<StableRealtimeChannel>
  >;
}

const pendingAblySubscriptions$ = state<readonly PendingAblySubscription[]>([]);

interface RealtimeSubscribeOptions {
  readonly onSubscribed?: () => void;
  readonly runOnForegroundCatchUp?: boolean;
  readonly runOnSubscribe?: boolean;
}

interface RealtimeLoopArgs {
  readonly channel: StableRealtimeChannel;
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface RealtimePayloadLoopArgs {
  readonly channel: StableRealtimeChannel;
  readonly topic: string | null;
  readonly passMessage?: boolean;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly catchUpCommand$?: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyLoopArgs {
  readonly scope?: RealtimeChannelScope;
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyPayloadLoopArgs {
  readonly topic: string;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly catchUpCommand$?: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyMessageLoopArgs {
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly catchUpCommand$?: Command<Promise<boolean> | boolean, [AbortSignal]>;
}

interface RealtimePayloadLoopState {
  deferred: ReturnType<typeof createDeferredPromise<boolean>>;
  poked: boolean;
  catchUpRequested: boolean;
  transientRetryCount: number;
  readonly pendingPayloads: unknown[];
}

interface RealtimePayloadLoopIterationArgs {
  readonly state: RealtimePayloadLoopState;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly catchUpCommand$?: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly pokeLoop: () => void;
}

async function waitForTransientRetry(
  signal: AbortSignal,
  retryCount: number,
): Promise<void> {
  const delayMs = IN_VITEST
    ? 0
    : (REALTIME_TRANSIENT_RETRY_DELAYS_MS[
        Math.min(retryCount, REALTIME_TRANSIENT_RETRY_DELAYS_MS.length - 1)
      ] ?? 30_000);
  await delay(delayMs, { signal });
  signal.throwIfAborted();
}

interface SubscribeChannelArgs {
  readonly channel: StableRealtimeChannel;
  readonly listenForForegroundCatchUp: boolean;
  readonly topic: string | null;
  readonly callback: ChannelCallback;
  readonly poke: () => void;
  readonly subscriberPokeTarget: EventTarget;
  readonly run: () => Promise<void>;
}

async function subscribeChannel(
  {
    channel,
    listenForForegroundCatchUp,
    topic,
    callback,
    poke,
    subscriberPokeTarget,
    run,
  }: SubscribeChannelArgs,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

  const unsubscribeChannel = () => {
    signal.removeEventListener("abort", unsubscribeChannel);
    channel.unsubscribe(topic, callback);
  };
  const release = () => {
    subscriberPokeTarget.removeEventListener(SUBSCRIBER_POKE_EVENT, poke);
    unsubscribeChannel();
  };

  if (listenForForegroundCatchUp) {
    subscriberPokeTarget.addEventListener(SUBSCRIBER_POKE_EVENT, poke, {
      signal,
    });
  }
  signal.addEventListener("abort", unsubscribeChannel, { once: true });

  await onRejection(channel.subscribe(topic, callback), release);
  signal.throwIfAborted();
  await withCleanup(run(), release);
  signal.throwIfAborted();
}

const runWithChannel$ = command(
  async (
    { get, set },
    { channel, topic, loopCommand$, options }: RealtimeLoopArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    // No implicit prime on subscribe by default. Callers whose loop body sets
    // up baseline state must run the body themselves before calling this, then
    // opt in to runOnSubscribe if they also need to catch events that occurred
    // between the baseline and subscription.
    signal.throwIfAborted();
    let deferred = createDeferredPromise(signal);
    let poked = false;
    let catchUpRequested = false;
    let transientRetryCount = 0;

    const pokeLoop = () => {
      if (signal.aborted || poked || deferred.settled()) {
        return;
      }
      poked = true;
      deferred.resolve(true);
    };
    const requestCatchUp = () => {
      catchUpRequested = true;
      pokeLoop();
    };

    const callback = (message: InboundMessage) => {
      if (signal.aborted) {
        return;
      }
      L.debug("got message from topic", topic, message);
      pokeLoop();
    };
    await subscribeChannel(
      {
        channel,
        listenForForegroundCatchUp: options?.runOnForegroundCatchUp !== false,
        topic,
        callback,
        poke: requestCatchUp,
        subscriberPokeTarget: get(subscriberPokeTarget$),
        run: async () => {
          options?.onSubscribed?.();
          if (options?.runOnSubscribe) {
            pokeLoop();
          }
          L.debug("subscribed to topic: " + topic);

          await setLoop(
            async (loopSignal) => {
              await deferred.promise;
              loopSignal.throwIfAborted();
              deferred = createDeferredPromise(loopSignal);
              poked = false;
              const isCatchUp = catchUpRequested;
              catchUpRequested = false;
              const catchUpSpanId = isCatchUp
                ? createConnectionDiagnosticSpanId()
                : null;
              const catchUpStartedAtMs = isCatchUp ? now() : null;
              if (catchUpSpanId !== null) {
                publishConnectionDiagnostic({
                  details: { subscriptionKind: "topic" },
                  event: "realtime.subscriber-catch-up",
                  phase: "start",
                  spanId: catchUpSpanId,
                });
              }

              // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
              try {
                const done = await set(loopCommand$, loopSignal);
                loopSignal.throwIfAborted();
                if (catchUpSpanId !== null && catchUpStartedAtMs !== null) {
                  publishConnectionDiagnostic({
                    details: { subscriptionKind: "topic" },
                    durationMs: now() - catchUpStartedAtMs,
                    event: "realtime.subscriber-catch-up",
                    phase: "finish",
                    spanId: catchUpSpanId,
                  });
                }
                transientRetryCount = 0;
                if (done) {
                  return true;
                }
              } catch (error) {
                throwIfAbort(error);
                loopSignal.throwIfAborted();
                if (catchUpSpanId !== null && catchUpStartedAtMs !== null) {
                  publishConnectionDiagnostic({
                    details: {
                      ...connectionDiagnosticError(error),
                      subscriptionKind: "topic",
                    },
                    durationMs: now() - catchUpStartedAtMs,
                    event: "realtime.subscriber-catch-up",
                    phase: "error",
                    spanId: catchUpSpanId,
                  });
                }
                if (transientRetryCount >= MAX_TRANSIENT_RETRIES) {
                  L.warn(
                    `giving up on ably notification after repeated handler failures`,
                    error,
                  );
                  transientRetryCount = 0;
                  set(notifyRealtimeDegraded$);
                  return false;
                }
                L.warn(`transient error in ably notification`, error);
                await waitForTransientRetry(loopSignal, transientRetryCount);
                loopSignal.throwIfAborted();
                transientRetryCount++;
                catchUpRequested = isCatchUp;
                pokeLoop();
              }
              return false;
            },
            0,
            signal,
          );
        },
      },
      signal,
    );
  },
);

const runPayloadLoopIteration$ = command(
  async (
    { set },
    {
      state,
      loopCommand$,
      catchUpCommand$,
      pokeLoop,
    }: RealtimePayloadLoopIterationArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    await state.deferred.promise;
    signal.throwIfAborted();
    state.deferred = createDeferredPromise(signal);
    state.poked = false;

    const hasPayload = state.pendingPayloads.length > 0;
    if (
      !hasPayload &&
      (!state.catchUpRequested || catchUpCommand$ === undefined)
    ) {
      return false;
    }
    if (!hasPayload && catchUpCommand$ !== undefined) {
      state.catchUpRequested = false;
      const catchUpSpanId = createConnectionDiagnosticSpanId();
      const catchUpStartedAtMs = now();
      publishConnectionDiagnostic({
        details: { subscriptionKind: "payload" },
        event: "realtime.subscriber-catch-up",
        phase: "start",
        spanId: catchUpSpanId,
      });
      const result = await settle(
        (async () => {
          return await set(catchUpCommand$, signal);
        })(),
        signal,
      );
      if (!result.ok) {
        publishConnectionDiagnostic({
          details: {
            ...connectionDiagnosticError(result.error),
            subscriptionKind: "payload",
          },
          durationMs: now() - catchUpStartedAtMs,
          event: "realtime.subscriber-catch-up",
          phase: "error",
          spanId: catchUpSpanId,
        });
        L.warn(`ably catch-up failed`, result.error);
        set(notifyRealtimeDegraded$);
      } else {
        publishConnectionDiagnostic({
          details: { subscriptionKind: "payload" },
          durationMs: now() - catchUpStartedAtMs,
          event: "realtime.subscriber-catch-up",
          phase: "finish",
          spanId: catchUpSpanId,
        });
      }
      if (result.ok && result.value) {
        return true;
      }
      if (state.pendingPayloads.length > 0 || state.catchUpRequested) {
        pokeLoop();
      }
      return false;
    }

    const payload = state.pendingPayloads[0];
    let done = false;
    // eslint-disable-next-line no-restricted-syntax -- payload notifications retry transient handler failures before dropping a poisoned queue item
    try {
      done = await set(loopCommand$, payload, signal);
      signal.throwIfAborted();
    } catch (error) {
      throwIfAbort(error);
      signal.throwIfAborted();
      if (state.transientRetryCount >= MAX_TRANSIENT_RETRIES) {
        L.warn(`dropping ably payload after repeated handler failures`, error);
        state.pendingPayloads.shift();
        state.transientRetryCount = 0;
        set(notifyRealtimeDegraded$);
        if (state.pendingPayloads.length > 0 || state.catchUpRequested) {
          pokeLoop();
        }
        return false;
      }
      L.warn(`transient error in ably payload notification`, error);
      await waitForTransientRetry(signal, state.transientRetryCount);
      signal.throwIfAborted();
      state.transientRetryCount++;
      pokeLoop();
      return false;
    }
    state.pendingPayloads.shift();
    state.transientRetryCount = 0;
    if (done) {
      return true;
    }
    if (state.pendingPayloads.length > 0 || state.catchUpRequested) {
      pokeLoop();
    }
    return false;
  },
);

const runWithChannelPayload$ = command(
  async (
    { get, set },
    args: RealtimePayloadLoopArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const {
      channel,
      topic,
      passMessage,
      loopCommand$,
      catchUpCommand$,
      options,
    } = args;
    signal.throwIfAborted();
    const subscriptionLabel = topic ?? "all user channel messages";
    const state: RealtimePayloadLoopState = {
      deferred: createDeferredPromise(signal),
      poked: false,
      catchUpRequested: false,
      transientRetryCount: 0,
      pendingPayloads: [],
    };

    const pokeLoop = () => {
      if (signal.aborted || state.poked || state.deferred.settled()) {
        return;
      }
      state.poked = true;
      state.deferred.resolve(true);
    };

    const requestCatchUp = () => {
      if (catchUpCommand$ !== undefined) {
        state.catchUpRequested = true;
      }
      pokeLoop();
    };

    const callback = (message: InboundMessage) => {
      if (signal.aborted) {
        return;
      }
      L.debug("got queued message from topic", subscriptionLabel, message);
      state.pendingPayloads.push(passMessage ? message : message.data);
      pokeLoop();
    };
    await subscribeChannel(
      {
        channel,
        listenForForegroundCatchUp: options?.runOnForegroundCatchUp !== false,
        topic,
        callback,
        poke: requestCatchUp,
        subscriberPokeTarget: get(subscriberPokeTarget$),
        run: async () => {
          options?.onSubscribed?.();
          if (options?.runOnSubscribe) {
            requestCatchUp();
          }
          L.debug("subscribed to payload topic: " + subscriptionLabel);

          await setLoop(
            async (loopSignal) => {
              return await set(
                runPayloadLoopIteration$,
                {
                  state,
                  loopCommand$,
                  catchUpCommand$,
                  pokeLoop,
                },
                loopSignal,
              );
            },
            0,
            signal,
          );
        },
      },
      signal,
    );
  },
);

interface ActiveChannelSubscription {
  readonly topic: string | null;
  readonly callback: ChannelCallback;
  readonly channels: Set<RealtimeChannel>;
}

function subscribeToRealtimeChannel(
  channel: RealtimeChannel,
  subscription: ActiveChannelSubscription,
): Promise<unknown> {
  if (subscription.topic === null) {
    return channel.subscribe(subscription.callback);
  }
  return channel.subscribe(subscription.topic, subscription.callback);
}

function unsubscribeFromRealtimeChannel(
  channel: RealtimeChannel,
  subscription: ActiveChannelSubscription,
): void {
  if (subscription.topic === null) {
    channel.unsubscribe(subscription.callback);
    return;
  }
  channel.unsubscribe(subscription.topic, subscription.callback);
}

async function trackRealtimeSubscription(
  operation: () => Promise<unknown>,
  subscription: ActiveChannelSubscription,
  subscriberCount: number,
): Promise<void> {
  const spanId = createConnectionDiagnosticSpanId();
  const startedAtMs = now();
  publishConnectionDiagnostic({
    details: {
      subscriberCount,
      subscriptionKind: subscription.topic === null ? "channel" : "topic",
    },
    event: "realtime.subscription",
    phase: "start",
    spanId,
  });
  const result = await settle(operation());
  if (!result.ok) {
    publishConnectionDiagnostic({
      details: {
        ...connectionDiagnosticError(result.error),
        subscriberCount,
        subscriptionKind: subscription.topic === null ? "channel" : "topic",
      },
      durationMs: now() - startedAtMs,
      event: "realtime.subscription",
      phase: "error",
      spanId,
    });
    throw result.error;
  }
  publishConnectionDiagnostic({
    details: {
      subscriberCount,
      subscriptionKind: subscription.topic === null ? "channel" : "topic",
    },
    durationMs: now() - startedAtMs,
    event: "realtime.subscription",
    phase: "finish",
    spanId,
  });
}

function unsubscribeRealtimeSubscriptionChannels(
  subscriptions: Iterable<ActiveChannelSubscription>,
): void {
  for (const subscription of subscriptions) {
    for (const channel of subscription.channels) {
      unsubscribeFromRealtimeChannel(channel, subscription);
    }
    subscription.channels.clear();
  }
}

interface StableRealtimeChannelState {
  currentChannel: RealtimeChannel | null;
  paused: boolean;
  replacement: Promise<void> | null;
  replacementChannel: RealtimeChannel | null;
  readonly subscriptions: Map<ChannelCallback, ActiveChannelSubscription>;
}

async function attachStableRealtimeSubscription(
  state: StableRealtimeChannelState,
  channel: RealtimeChannel,
  subscription: ActiveChannelSubscription,
): Promise<void> {
  if (subscription.channels.has(channel)) {
    return;
  }
  await trackRealtimeSubscription(
    () => {
      return onRejection(
        subscribeToRealtimeChannel(channel, subscription),
        () => {
          unsubscribeFromRealtimeChannel(channel, subscription);
        },
      );
    },
    subscription,
    state.subscriptions.size,
  );
  if (
    state.subscriptions.get(subscription.callback) !== subscription ||
    state.paused ||
    (channel !== state.currentChannel && channel !== state.replacementChannel)
  ) {
    unsubscribeFromRealtimeChannel(channel, subscription);
    return;
  }
  subscription.channels.add(channel);
}

async function subscribeStableRealtimeChannel(
  state: StableRealtimeChannelState,
  topic: string | null,
  callback: ChannelCallback,
): Promise<void> {
  const subscription: ActiveChannelSubscription = {
    topic,
    callback,
    channels: new Set(),
  };
  state.subscriptions.set(callback, subscription);

  if (state.paused) {
    return;
  }
  const activeReplacement = state.replacement;
  if (activeReplacement) {
    await activeReplacement;
  }
  if (
    state.subscriptions.get(callback) !== subscription ||
    state.paused ||
    !state.currentChannel
  ) {
    return;
  }
  await attachStableRealtimeSubscription(
    state,
    state.currentChannel,
    subscription,
  );
}

async function resumeStableRealtimeSubscriptions(
  state: StableRealtimeChannelState,
): Promise<void> {
  state.paused = false;
  const activeReplacement = state.replacement;
  if (activeReplacement) {
    await activeReplacement;
  }
  const channel = state.currentChannel;
  if (state.paused || !channel) {
    return;
  }
  const results = await Promise.allSettled(
    [...state.subscriptions.values()].map(async (subscription) => {
      await attachStableRealtimeSubscription(state, channel, subscription);
    }),
  );
  const failure = results.find((result) => {
    return result.status === "rejected";
  });
  if (failure?.status === "rejected") {
    state.paused = true;
    unsubscribeRealtimeSubscriptionChannels(state.subscriptions.values());
    throw failure.reason;
  }
}

async function replaceStableRealtimeChannel(
  state: StableRealtimeChannelState,
  channel: RealtimeChannel,
): Promise<void> {
  const activeReplacement = state.replacement;
  if (activeReplacement) {
    await activeReplacement;
  }

  const activeSubscriptions = [...state.subscriptions.values()];
  state.replacementChannel = channel;
  const replacePromise = (async () => {
    const results = state.paused
      ? []
      : await Promise.allSettled(
          activeSubscriptions.map(async (subscription) => {
            await attachStableRealtimeSubscription(
              state,
              channel,
              subscription,
            );
          }),
        );
    const failure = results.find((result) => {
      return result.status === "rejected";
    });
    if (failure?.status === "rejected") {
      for (const subscription of activeSubscriptions) {
        if (subscription.channels.delete(channel)) {
          unsubscribeFromRealtimeChannel(channel, subscription);
        }
      }
      throw failure.reason;
    }

    state.currentChannel = channel;
    for (const subscription of state.subscriptions.values()) {
      for (const attachedChannel of subscription.channels) {
        if (attachedChannel !== channel) {
          unsubscribeFromRealtimeChannel(attachedChannel, subscription);
          subscription.channels.delete(attachedChannel);
        }
      }
    }
  })();
  state.replacement = replacePromise;
  await withCleanup(replacePromise, () => {
    if (state.replacement === replacePromise) {
      state.replacement = null;
      state.replacementChannel = null;
    }
  });
}

function createStableRealtimeChannel(
  initialChannel: RealtimeChannel,
): StableRealtimeChannel {
  const state: StableRealtimeChannelState = {
    currentChannel: initialChannel,
    paused: false,
    replacement: null,
    replacementChannel: null,
    subscriptions: new Map(),
  };

  return {
    state: () => {
      return state.currentChannel?.state ?? null;
    },
    subscribe: async (topic, callback) => {
      await subscribeStableRealtimeChannel(state, topic, callback);
    },
    unsubscribe: (_topic, callback) => {
      const subscription = state.subscriptions.get(callback);
      if (!subscription) {
        return;
      }
      state.subscriptions.delete(callback);
      for (const channel of subscription.channels) {
        unsubscribeFromRealtimeChannel(channel, subscription);
      }
      subscription.channels.clear();
    },
    pauseSubscriptions: () => {
      state.paused = true;
      unsubscribeRealtimeSubscriptionChannels(state.subscriptions.values());
    },
    resumeSubscriptions: async () => {
      await resumeStableRealtimeSubscriptions(state);
    },
    suspend: () => {
      state.paused = true;
      state.currentChannel = null;
      unsubscribeRealtimeSubscriptionChannels(state.subscriptions.values());
    },
    replace: async (channel) => {
      await replaceStableRealtimeChannel(state, channel);
    },
  };
}

interface ConnectedRealtimeChannels {
  readonly user: RealtimeChannel;
  readonly org: RealtimeChannel;
}

function connectedRealtimeChannels(
  ably: AblyRealtime,
  userId: string,
  orgId: string,
): ConnectedRealtimeChannels {
  return {
    user: ably.channels.get(`user:${userId}`),
    org: ably.channels.get(`org:${orgId}`),
  };
}

function observeRealtimeChannels(
  channels: ConnectedRealtimeChannels,
  onStateChange: () => void,
): () => void {
  const handleStateChange = (stateChange: ChannelStateChange): void => {
    onStateChange();
    publishConnectionDiagnostic({
      details: channelStateDetails(stateChange),
      event: "realtime.channel",
      phase: "instant",
    });
  };
  channels.user.on(handleStateChange);
  channels.org.on(handleStateChange);
  return () => {
    channels.user.off(handleStateChange);
    channels.org.off(handleStateChange);
  };
}

interface ConnectedRealtimeClient {
  readonly ably: AblyRealtime;
  readonly channels: ConnectedRealtimeChannels;
  readonly close: () => void;
}

const connectRealtimeClient$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ConnectedRealtimeClient> => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const createClient = get(apiClient$);
    const client = createClient(platformRealtimeTokenContract);
    const ably = createAblyRealtime({
      // Ably TokenRequest is single-use — see lib/ably-auth.ts for why
      // every invocation must fetch a freshly-signed request.
      authCallback: createAblyAuthCallback(client, signal),
      autoConnect: true,
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15_000,
    });
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      event: "realtime.client",
      phase: "instant",
    });
    let initialConnectionComplete = false;
    const handleConnectionStateChange = (
      stateChange: ConnectionStateChange,
    ): void => {
      set(realtimeStateRevision$, (revision) => {
        return revision + 1;
      });
      publishConnectionDiagnostic({
        details: connectionStateDetails(stateChange),
        event: "realtime.connection",
        phase: "instant",
      });
      if (initialConnectionComplete && stateChange.current === "connected") {
        L.debug("reconnected, requesting foreground catch-up");
        set(requestForegroundCatchUp$);
      }
    };
    ably.connection.on(handleConnectionStateChange);

    let closed = false;
    const closeConnection = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      signal.removeEventListener("abort", closeConnection);
      ably.close();
      ably.connection.off(handleConnectionStateChange);
    };
    signal.addEventListener("abort", closeConnection, { once: true });

    const deferred = createDeferredPromise(signal);
    ably.connection.once("connected", () => {
      if (!deferred.settled()) {
        deferred.resolve(true);
      }
    });
    ably.connection.once("failed", (stateChange) => {
      if (!deferred.settled()) {
        deferred.reject(
          new Error(
            `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
          ),
        );
      }
    });

    const initialConnectionSpanId = createConnectionDiagnosticSpanId();
    const initialConnectionStartedAtMs = now();
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      event: "realtime.initial-connection",
      phase: "start",
      spanId: initialConnectionSpanId,
    });
    const initialConnectionResult = await settle(deferred.promise, signal);
    if (!initialConnectionResult.ok) {
      publishConnectionDiagnostic({
        details: {
          ...connectionDiagnosticError(initialConnectionResult.error),
          connectionState: ably.connection.state,
        },
        durationMs: now() - initialConnectionStartedAtMs,
        event: "realtime.initial-connection",
        phase: "error",
        spanId: initialConnectionSpanId,
      });
      closeConnection();
      throw initialConnectionResult.error;
    }
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      durationMs: now() - initialConnectionStartedAtMs,
      event: "realtime.initial-connection",
      phase: "finish",
      spanId: initialConnectionSpanId,
    });
    initialConnectionComplete = true;

    const channels = connectedRealtimeChannels(
      ably,
      identity.userId,
      identity.orgId,
    );
    const stopObservingChannels = observeRealtimeChannels(channels, () => {
      set(realtimeStateRevision$, (revision) => {
        return revision + 1;
      });
    });
    publishConnectionDiagnostic({
      details: { channelState: channels.user.state },
      event: "realtime.channel",
      phase: "instant",
    });
    const close = (): void => {
      signal.removeEventListener("abort", close);
      closeConnection();
      stopObservingChannels();
    };
    signal.removeEventListener("abort", closeConnection);
    signal.addEventListener("abort", close, { once: true });
    return {
      ably,
      channels,
      close,
    };
  },
);

const resetRealtimeCloseSignal$ = resetSignal();
const realtimeCloseDue$ = state(false);

const cancelRealtimeClose$ = command(({ set }, signal: AbortSignal): void => {
  set(resetRealtimeCloseSignal$, signal);
  set(realtimeCloseDue$, false);
});

const closeRealtimeWhileHidden$ = command(({ get, set }) => {
  if (document.visibilityState === "visible") {
    return;
  }
  const session = get(internalRealtimeSession$);
  if (!session) {
    return;
  }
  L.debug("page hidden, closing realtime connection");
  session.channels.user.suspend();
  session.channels.org.suspend();
  session.close();
  set(realtimeStateRevision$, (revision) => {
    return revision + 1;
  });
});

const updateRealtimeVisibility$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (isDocumentVisible()) {
      set(cancelRealtimeClose$, signal);
      return;
    }

    const session = get(internalRealtimeSession$);
    if (!session) {
      return;
    }
    L.debug("page hidden, pausing realtime subscriptions");
    session.channels.user.pauseSubscriptions();
    session.channels.org.pauseSubscriptions();
    set(realtimeCloseDue$, false);
    const closeSignal = set(resetRealtimeCloseSignal$, signal);
    await delay(realtimeBackgroundCloseDelayMs, { signal: closeSignal });
    signal.throwIfAborted();
    closeSignal.throwIfAborted();
    if (isDocumentVisible()) {
      return;
    }
    set(realtimeCloseDue$, true);
    set(closeRealtimeWhileHidden$);
  },
);

const foregroundRealtimeCatchUp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (document.visibilityState === "visible") {
      set(cancelRealtimeClose$, signal);
    }
    const session = get(internalRealtimeSession$);
    const subscriberPokeTarget = get(subscriberPokeTarget$);
    if (!session) {
      publishConnectionDiagnostic({
        details: { skipReason: "no-realtime-session" },
        event: "foreground.skipped",
        phase: "instant",
      });
      return;
    }

    const connectionState = session.ably.connection.state;
    if (
      connectionState === "failed" ||
      connectionState === "closing" ||
      connectionState === "closed"
    ) {
      L.debug("foreground catch-up rebuilding inactive realtime connection");
      const rebuildSpanId = createConnectionDiagnosticSpanId();
      const rebuildStartedAtMs = now();
      publishConnectionDiagnostic({
        details: { connectionState },
        event: "realtime.client-rebuild",
        phase: "start",
        spanId: rebuildSpanId,
      });
      const connectResult = await settle(
        set(connectRealtimeClient$, signal),
        signal,
      );
      if (!connectResult.ok) {
        publishConnectionDiagnostic({
          details: connectionDiagnosticError(connectResult.error),
          durationMs: now() - rebuildStartedAtMs,
          event: "realtime.client-rebuild",
          phase: "error",
          spanId: rebuildSpanId,
        });
        throw connectResult.error;
      }

      const connected = connectResult.value;
      const replaceSpanId = createConnectionDiagnosticSpanId();
      const replaceStartedAtMs = now();
      publishConnectionDiagnostic({
        event: "realtime.channel-replace",
        phase: "start",
        spanId: replaceSpanId,
      });
      const replaceResult = await settle(
        onRejection(
          Promise.all([
            session.channels.user.replace(connected.channels.user),
            session.channels.org.replace(connected.channels.org),
          ]),
          () => {
            connected.close();
          },
        ),
        signal,
      );
      if (!replaceResult.ok) {
        publishConnectionDiagnostic({
          details: connectionDiagnosticError(replaceResult.error),
          durationMs: now() - replaceStartedAtMs,
          event: "realtime.channel-replace",
          phase: "error",
          spanId: replaceSpanId,
        });
        publishConnectionDiagnostic({
          details: connectionDiagnosticError(replaceResult.error),
          durationMs: now() - rebuildStartedAtMs,
          event: "realtime.client-rebuild",
          phase: "error",
          spanId: rebuildSpanId,
        });
        throw replaceResult.error;
      }
      publishConnectionDiagnostic({
        durationMs: now() - replaceStartedAtMs,
        event: "realtime.channel-replace",
        phase: "finish",
        spanId: replaceSpanId,
      });
      set(internalRealtimeSession$, {
        ably: connected.ably,
        channels: session.channels,
        close: connected.close,
      });
      session.close();
      publishConnectionDiagnostic({
        details: { connectionState: connected.ably.connection.state },
        durationMs: now() - rebuildStartedAtMs,
        event: "realtime.client-rebuild",
        phase: "finish",
        spanId: rebuildSpanId,
      });
    }

    if (document.visibilityState !== "visible") {
      session.channels.user.pauseSubscriptions();
      session.channels.org.pauseSubscriptions();
      if (get(realtimeCloseDue$)) {
        set(closeRealtimeWhileHidden$);
      }
      return;
    }

    await Promise.all([
      session.channels.user.resumeSubscriptions(),
      session.channels.org.resumeSubscriptions(),
    ]);
    signal.throwIfAborted();
    L.debug("foreground catch-up ready, poking subscribers");
    subscriberPokeTarget.dispatchEvent(new Event(SUBSCRIBER_POKE_EVENT));
    await set(runRealtimeReadyCatchUp$, signal);
    signal.throwIfAborted();
  },
);

/**
 * Initialize the Ably realtime client and its user and active-org channels.
 * Call once during app bootstrap, after Clerk auth is ready.
 */
export const setupRealtime$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const rejectPendingSubscriptions = (reason?: unknown) => {
      const pendingSubscriptions = get(pendingAblySubscriptions$);
      if (pendingSubscriptions.length === 0) {
        return;
      }
      for (const pendingSubscription of pendingSubscriptions) {
        if (!pendingSubscription.channelDeferred.settled()) {
          pendingSubscription.channelDeferred.reject(reason);
        }
      }
      set(pendingAblySubscriptions$, []);
    };

    signal.addEventListener(
      "abort",
      () => {
        set(internalRealtimeSession$, null);
        rejectPendingSubscriptions(signal.reason);
      },
      { once: true },
    );

    const connected = await onRejection(
      set(connectRealtimeClient$, signal),
      rejectPendingSubscriptions,
    );
    signal.throwIfAborted();
    const channels: RealtimeSessionChannels = {
      user: createStableRealtimeChannel(connected.channels.user),
      org: createStableRealtimeChannel(connected.channels.org),
    };
    set(internalRealtimeSession$, {
      ably: connected.ably,
      channels,
      close: connected.close,
    });
    set(subscribeForegroundCatchUp$, foregroundRealtimeCatchUp$, signal);
    const handleVisibilityChange = onDomEventFn(async () => {
      await set(updateRealtimeVisibility$, signal);
    });
    document.addEventListener("visibilitychange", handleVisibilityChange, {
      signal,
    });
    handleVisibilityChange(new Event("visibilitychange"));

    const pendingSubscriptions = get(pendingAblySubscriptions$);
    if (pendingSubscriptions.length > 0) {
      publishConnectionDiagnostic({
        details: { pendingSubscriberCount: pendingSubscriptions.length },
        event: "realtime.pending-subscribers",
        phase: "start",
      });
      L.debug(
        `Realtime connected, starting ${pendingSubscriptions.length} pending subscriber(s)`,
      );
      for (const pendingSubscription of pendingSubscriptions) {
        if (pendingSubscription.signal.aborted) {
          if (!pendingSubscription.channelDeferred.settled()) {
            pendingSubscription.channelDeferred.reject(
              pendingSubscription.signal.reason,
            );
          }
          continue;
        }
        if (!pendingSubscription.channelDeferred.settled()) {
          pendingSubscription.channelDeferred.resolve(
            channels[pendingSubscription.scope],
          );
        }
      }
      set(pendingAblySubscriptions$, []);
      publishConnectionDiagnostic({
        details: { pendingSubscriberCount: 0 },
        event: "realtime.pending-subscribers",
        phase: "finish",
      });
    }

    L.debug(`Realtime connected for user:${connected.ably.auth.clientId}`);
  },
);

const realtimeChannel$ = command(
  async (
    { get, set },
    scope: RealtimeChannelScope,
    topic: string,
    signal: AbortSignal,
  ): Promise<StableRealtimeChannel> => {
    signal.throwIfAborted();

    const session = get(internalRealtimeSession$);
    if (session) {
      return session.channels[scope];
    }

    const channelDeferred =
      createDeferredPromise<StableRealtimeChannel>(signal);
    const pendingSubscription: PendingAblySubscription = {
      scope,
      topic,
      signal,
      channelDeferred,
    };
    publishConnectionDiagnostic({
      details: {
        pendingSubscriberCount: get(pendingAblySubscriptions$).length + 1,
      },
      event: "realtime.pending-subscribers",
      phase: "instant",
    });
    set(pendingAblySubscriptions$, (prev) => {
      return [...prev, pendingSubscription];
    });

    const connectedChannel = await channelDeferred.promise;
    signal.throwIfAborted();
    return connectedChannel;
  },
);

export const setAblyLoop$ = command(
  async (
    { set },
    { scope = "user", topic, loopCommand$, options }: SetAblyLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(realtimeChannel$, scope, topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannel$,
      { channel, topic, loopCommand$, options },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const setAblyPayloadLoop$ = command(
  async (
    { set },
    { topic, loopCommand$, catchUpCommand$, options }: SetAblyPayloadLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(realtimeChannel$, "user", topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannelPayload$,
      { channel, topic, loopCommand$, catchUpCommand$, options },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const setAblyMessageLoop$ = command(
  async (
    { set },
    { loopCommand$, catchUpCommand$ }: SetAblyMessageLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(
      realtimeChannel$,
      "user",
      "all user channel messages",
      signal,
    );
    signal.throwIfAborted();
    await set(
      runWithChannelPayload$,
      {
        channel,
        topic: null,
        passMessage: true,
        loopCommand$,
        catchUpCommand$,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);
