import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { zeroClient$ } from "./api-client.ts";
import {
  requestForegroundCatchUp$,
  subscribeForegroundCatchUp$,
} from "./auth-retry.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import {
  createDeferredPromise,
  onRejection,
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
  readonly subscribe: (
    topic: string | null,
    callback: ChannelCallback,
  ) => Promise<unknown>;
  readonly unsubscribe: (
    topic: string | null,
    callback: ChannelCallback,
  ) => void;
  readonly replace: (channel: RealtimeChannel) => Promise<void>;
}

interface RealtimeSession {
  readonly ably: Realtime;
  readonly channel: StableRealtimeChannel;
  readonly close: () => void;
}

const internalRealtimeSession$ = state<RealtimeSession | null>(null);

const subscriberPokeTarget$ = state(new EventTarget());
const SUBSCRIBER_POKE_EVENT = "poke";

interface PendingAblySubscription {
  topic: string;
  signal: AbortSignal;
  channelDeferred: ReturnType<
    typeof createDeferredPromise<StableRealtimeChannel>
  >;
}

const pendingAblySubscriptions$ = state<readonly PendingAblySubscription[]>([]);

interface RealtimeSubscribeOptions {
  readonly onSubscribed?: () => void;
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
  readonly topic: string | null;
  readonly callback: ChannelCallback;
  readonly poke: () => void;
  readonly subscriberPokeTarget: EventTarget;
  readonly run: () => Promise<void>;
}

async function subscribeChannel(
  {
    channel,
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

  subscriberPokeTarget.addEventListener(SUBSCRIBER_POKE_EVENT, poke, {
    signal,
  });
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
    let transientRetryCount = 0;

    const pokeLoop = () => {
      if (signal.aborted || poked || deferred.settled()) {
        return;
      }
      poked = true;
      deferred.resolve(true);
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
        topic,
        callback,
        poke: pokeLoop,
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

              // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
              try {
                const done = await set(loopCommand$, loopSignal);
                loopSignal.throwIfAborted();
                transientRetryCount = 0;
                if (done) {
                  return true;
                }
              } catch (error) {
                throwIfAbort(error);
                loopSignal.throwIfAborted();
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
      const result = await settle(
        (async () => {
          return await set(catchUpCommand$, signal);
        })(),
        signal,
      );
      if (!result.ok) {
        L.warn(`ably catch-up failed`, result.error);
        set(notifyRealtimeDegraded$);
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

function createStableRealtimeChannel(
  initialChannel: RealtimeChannel,
): StableRealtimeChannel {
  const subscriptions = new Map<ChannelCallback, ActiveChannelSubscription>();
  let currentChannel = initialChannel;
  let replacement: Promise<void> | null = null;

  const attach = async (
    channel: RealtimeChannel,
    subscription: ActiveChannelSubscription,
  ): Promise<void> => {
    if (subscription.channels.has(channel)) {
      return;
    }
    await onRejection(subscribeToRealtimeChannel(channel, subscription), () => {
      unsubscribeFromRealtimeChannel(channel, subscription);
    });
    if (subscriptions.get(subscription.callback) !== subscription) {
      unsubscribeFromRealtimeChannel(channel, subscription);
      return;
    }
    subscription.channels.add(channel);
  };

  return {
    subscribe: (topic, callback) => {
      const subscription: ActiveChannelSubscription = {
        topic,
        callback,
        channels: new Set(),
      };
      subscriptions.set(callback, subscription);

      const activeReplacement = replacement;
      if (!activeReplacement) {
        const channel = currentChannel;
        subscription.channels.add(channel);
        return subscribeToRealtimeChannel(channel, subscription);
      }

      return (async () => {
        await activeReplacement;
        if (subscriptions.get(callback) !== subscription) {
          return;
        }
        await attach(currentChannel, subscription);
      })();
    },
    unsubscribe: (_topic, callback) => {
      const subscription = subscriptions.get(callback);
      if (!subscription) {
        return;
      }
      subscriptions.delete(callback);
      for (const channel of subscription.channels) {
        unsubscribeFromRealtimeChannel(channel, subscription);
      }
      subscription.channels.clear();
    },
    replace: async (channel) => {
      const activeReplacement = replacement;
      if (activeReplacement) {
        await activeReplacement;
      }

      const activeSubscriptions = [...subscriptions.values()];
      const replacePromise = (async () => {
        const results = await Promise.allSettled(
          activeSubscriptions.map(async (subscription) => {
            await attach(channel, subscription);
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

        currentChannel = channel;
        for (const subscription of subscriptions.values()) {
          for (const attachedChannel of subscription.channels) {
            if (attachedChannel !== channel) {
              unsubscribeFromRealtimeChannel(attachedChannel, subscription);
              subscription.channels.delete(attachedChannel);
            }
          }
        }
      })();
      replacement = replacePromise;
      await withCleanup(replacePromise, () => {
        if (replacement === replacePromise) {
          replacement = null;
        }
      });
    },
  };
}

interface ConnectedRealtimeClient {
  readonly ably: Realtime;
  readonly channel: RealtimeChannel;
  readonly close: () => void;
}

const connectRealtimeClient$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ConnectedRealtimeClient> => {
    const createClient = get(zeroClient$);
    const client = createClient(platformRealtimeTokenContract);
    const ably = new Realtime({
      // Ably TokenRequest is single-use — see lib/ably-auth.ts for why
      // every invocation must fetch a freshly-signed request.
      authCallback: createAblyAuthCallback(client, signal),
      autoConnect: true,
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15_000,
    });
    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      signal.removeEventListener("abort", close);
      ably.close();
    };
    signal.addEventListener("abort", close, { once: true });

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

    await onRejection(deferred.promise, close);
    signal.throwIfAborted();

    // Register after the initial connection so only reconnects request a
    // foreground catch-up.
    ably.connection.on("connected", () => {
      L.debug("reconnected, requesting foreground catch-up");
      set(requestForegroundCatchUp$);
    });

    const channelName = `user:${ably.auth.clientId}`;
    return {
      ably,
      channel: ably.channels.get(channelName),
      close,
    };
  },
);

const foregroundRealtimeCatchUp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const session = get(internalRealtimeSession$);
    const subscriberPokeTarget = get(subscriberPokeTarget$);
    if (!session) {
      return;
    }

    if (session.ably.connection.state === "failed") {
      L.debug("foreground catch-up rebuilding failed realtime connection");
      const connected = await set(connectRealtimeClient$, signal);
      signal.throwIfAborted();
      await onRejection(session.channel.replace(connected.channel), () => {
        connected.close();
      });
      signal.throwIfAborted();
      set(internalRealtimeSession$, {
        ably: connected.ably,
        channel: session.channel,
        close: connected.close,
      });
      session.close();
    }

    L.debug("foreground catch-up ready, poking subscribers");
    subscriberPokeTarget.dispatchEvent(new Event(SUBSCRIBER_POKE_EVENT));
  },
);

/**
 * Initialize the Ably realtime client and subscribe to the user's channel.
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
    const channel = createStableRealtimeChannel(connected.channel);
    set(internalRealtimeSession$, {
      ably: connected.ably,
      channel,
      close: connected.close,
    });
    set(subscribeForegroundCatchUp$, foregroundRealtimeCatchUp$, signal);

    const pendingSubscriptions = get(pendingAblySubscriptions$);
    if (pendingSubscriptions.length > 0) {
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
          pendingSubscription.channelDeferred.resolve(channel);
        }
      }
      set(pendingAblySubscriptions$, []);
    }

    L.debug(
      `Realtime connected, subscribed to user:${connected.ably.auth.clientId}`,
    );
  },
);

const userChannel$ = command(
  async (
    { get, set },
    topic: string,
    signal: AbortSignal,
  ): Promise<StableRealtimeChannel> => {
    signal.throwIfAborted();

    const session = get(internalRealtimeSession$);
    if (session) {
      return session.channel;
    }

    const channelDeferred =
      createDeferredPromise<StableRealtimeChannel>(signal);
    const pendingSubscription: PendingAblySubscription = {
      topic,
      signal,
      channelDeferred,
    };
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
    { topic, loopCommand$, options }: SetAblyLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(userChannel$, topic, signal);
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
    const channel = await set(userChannel$, topic, signal);
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
      userChannel$,
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
