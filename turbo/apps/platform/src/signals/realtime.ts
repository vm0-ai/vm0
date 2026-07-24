import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { zeroClient$ } from "./api-client.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import { createDeferredPromise, setLoop, throwIfAbort } from "./utils.ts";
import { logger } from "./log.ts";

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
  toast.error("Live updates ran into a problem. Please refresh the page.");
});

const internalUserChannel$ = state<RealtimeChannel | null>(null);

const subscriberPokeRegistry$ = state<ReadonlySet<() => void>>(new Set());

interface PendingAblySubscription {
  topic: string;
  signal: AbortSignal;
  channelDeferred: ReturnType<typeof createDeferredPromise<RealtimeChannel>>;
}

const pendingAblySubscriptions$ = state<readonly PendingAblySubscription[]>([]);

interface RealtimeSubscribeOptions {
  readonly onSubscribed?: () => void;
  readonly runOnSubscribe?: boolean;
}

interface RealtimeLoopArgs {
  readonly channel: RealtimeChannel;
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface RealtimePayloadLoopArgs {
  readonly channel: RealtimeChannel;
  readonly topic: string | null;
  readonly passMessage?: boolean;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
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
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyMessageLoopArgs {
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}

function isAblyConnectionClosedError(error: unknown): boolean {
  return errorMessage(error) === "Connection closed";
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

const addPokeSubscriber$ = command(({ set }, pokeLoop: () => void) => {
  set(subscriberPokeRegistry$, (prev) => {
    const next = new Set(prev);
    next.add(pokeLoop);
    return next;
  });
});

const removePokeSubscriber$ = command(({ set }, pokeLoop: () => void) => {
  set(subscriberPokeRegistry$, (prev) => {
    const next = new Set(prev);
    next.delete(pokeLoop);
    return next;
  });
});

function registerVisibilityPoke(
  label: string,
  signal: AbortSignal,
  pokeLoop: () => void,
): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    L.debug("tab visible, poking loop", label);
    pokeLoop();
  };
  document.addEventListener("visibilitychange", onVisibilityChange, { signal });
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

const runWithChannel$ = command(
  async (
    { set },
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
    const unregisterVisibilityPoke = registerVisibilityPoke(
      topic,
      signal,
      pokeLoop,
    );
    set(addPokeSubscriber$, pokeLoop);

    const cleanup = () => {
      set(removePokeSubscriber$, pokeLoop);
      unregisterVisibilityPoke();
      channel.unsubscribe(topic, callback);
    };

    signal.addEventListener("abort", cleanup, { once: true });

    // eslint-disable-next-line no-restricted-syntax -- Ably can close during app teardown while a channel attach is in flight; suppress only that terminal close race.
    try {
      await channel.subscribe(topic, callback);
      signal.throwIfAborted();
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
              cleanup();
              return true;
            }
          } catch (error) {
            loopSignal.throwIfAborted();
            throwIfAbort(error);
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
    } catch (error) {
      signal.throwIfAborted();
      throwIfAbort(error);
      if (isAblyConnectionClosedError(error)) {
        L.debug("Ably connection closed before subscription completed", {
          topic,
        });
        return;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
);

const runWithChannelPayload$ = command(
  async (
    { set },
    args: RealtimePayloadLoopArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const { channel, topic, passMessage, loopCommand$, options } = args;
    signal.throwIfAborted();
    const subscriptionLabel = topic ?? "all user channel messages";
    let deferred = createDeferredPromise(signal);
    let poked = false;
    let transientRetryCount = 0;
    const pendingPayloads: unknown[] = [];

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
      L.debug("got queued message from topic", subscriptionLabel, message);
      pendingPayloads.push(passMessage ? message : message.data);
      pokeLoop();
    };
    const unregisterVisibilityPoke = registerVisibilityPoke(
      subscriptionLabel,
      signal,
      pokeLoop,
    );
    set(addPokeSubscriber$, pokeLoop);

    const cleanup = () => {
      set(removePokeSubscriber$, pokeLoop);
      unregisterVisibilityPoke();
      if (topic === null) {
        channel.unsubscribe(callback);
      } else {
        channel.unsubscribe(topic, callback);
      }
    };

    signal.addEventListener("abort", cleanup, { once: true });

    // eslint-disable-next-line no-restricted-syntax -- Ably can close during app teardown while a channel attach is in flight; suppress only that terminal close race.
    try {
      if (topic === null) {
        await channel.subscribe(callback);
      } else {
        await channel.subscribe(topic, callback);
      }
      signal.throwIfAborted();
      options?.onSubscribed?.();
      L.debug("subscribed to payload topic: " + subscriptionLabel);

      await setLoop(
        async (loopSignal) => {
          await deferred.promise;
          loopSignal.throwIfAborted();
          deferred = createDeferredPromise(loopSignal);
          poked = false;

          const payload = pendingPayloads[0];
          if (payload === undefined) {
            return false;
          }

          let done = false;
          // eslint-disable-next-line no-restricted-syntax -- payload notifications retry transient handler failures a few times before dropping the payload
          try {
            done = await set(loopCommand$, payload, loopSignal);
            loopSignal.throwIfAborted();
          } catch (error) {
            loopSignal.throwIfAborted();
            throwIfAbort(error);
            if (transientRetryCount >= MAX_TRANSIENT_RETRIES) {
              L.warn(
                `dropping ably payload after repeated handler failures`,
                error,
              );
              pendingPayloads.shift();
              transientRetryCount = 0;
              set(notifyRealtimeDegraded$);
              if (pendingPayloads.length > 0) {
                pokeLoop();
              }
              return false;
            }
            L.warn(`transient error in ably payload notification`, error);
            await waitForTransientRetry(loopSignal, transientRetryCount);
            loopSignal.throwIfAborted();
            transientRetryCount++;
            pokeLoop();
            return false;
          }
          pendingPayloads.shift();
          transientRetryCount = 0;
          if (done) {
            cleanup();
            return true;
          }
          if (pendingPayloads.length > 0) {
            pokeLoop();
          }
          return false;
        },
        0,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      throwIfAbort(error);
      if (isAblyConnectionClosedError(error)) {
        L.debug(
          "Ably connection closed before payload subscription completed",
          {
            topic: subscriptionLabel,
          },
        );
        return;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
);

/**
 * Initialize the Ably realtime client and subscribe to the user's channel.
 * Call once during app bootstrap, after Clerk auth is ready.
 */
export const setupRealtime$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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

    signal.addEventListener("abort", () => {
      ably.close();
      set(internalUserChannel$, null);
      rejectPendingSubscriptions(signal.reason);
    });

    const deferred = createDeferredPromise(signal);

    ably.connection.once("connected", () => {
      if (!deferred.settled()) {
        deferred.resolve(true);
      }
    });

    ably.connection.once("failed", (stateChange) => {
      const error = new Error(
        `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
      );
      if (!deferred.settled()) {
        deferred.reject(error);
      }
      rejectPendingSubscriptions(error);
    });

    ably.connection.on("connected", () => {
      const registry = get(subscriberPokeRegistry$);
      if (registry.size === 0) {
        return;
      }
      L.debug(`reconnected, poking ${registry.size} subscriber(s)`);
      for (const poke of registry) {
        poke();
      }
    });

    await deferred.promise;
    signal.throwIfAborted();

    const channelName = `user:${ably.auth.clientId}`;
    const channel = ably.channels.get(channelName);
    set(internalUserChannel$, channel);

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

    L.debug(`Realtime connected, subscribed to ${channelName}`);
  },
);

const userChannel$ = command(
  async (
    { get, set },
    topic: string,
    signal: AbortSignal,
  ): Promise<RealtimeChannel> => {
    signal.throwIfAborted();

    const channel = get(internalUserChannel$);
    if (channel) {
      return channel;
    }

    const channelDeferred = createDeferredPromise<RealtimeChannel>(signal);
    const pendingSubscription: PendingAblySubscription = {
      topic,
      signal,
      channelDeferred,
    };
    const removePendingSubscription = () => {
      set(pendingAblySubscriptions$, (prev) => {
        return prev.filter((item) => {
          return item !== pendingSubscription;
        });
      });
    };

    signal.addEventListener("abort", removePendingSubscription, {
      once: true,
    });
    set(pendingAblySubscriptions$, (prev) => {
      return [...prev, pendingSubscription];
    });

    const connectedChannel = await channelDeferred.promise.finally(() => {
      signal.removeEventListener("abort", removePendingSubscription);
    });
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
    { topic, loopCommand$, options }: SetAblyPayloadLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(userChannel$, topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannelPayload$,
      { channel, topic, loopCommand$, options },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const setAblyMessageLoop$ = command(
  async (
    { set },
    { loopCommand$ }: SetAblyMessageLoopArgs,
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
      { channel, topic: null, passMessage: true, loopCommand$ },
      signal,
    );
    signal.throwIfAborted();
  },
);
