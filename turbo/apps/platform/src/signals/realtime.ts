import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core/contracts/realtime";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { zeroClient$ } from "./api-client.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import { createDeferredPromise, throwIfAbort } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("Realtime");

const internalUserChannel$ = state<RealtimeChannel | null>(null);

const subscriberPokeRegistry$ = state<ReadonlySet<() => void>>(new Set());

interface PendingAblySubscription {
  topic: string;
  signal: AbortSignal;
  start: (channel: RealtimeChannel) => void;
  reject: (reason?: unknown) => void;
}

const pendingAblySubscriptions$ = state<readonly PendingAblySubscription[]>([]);

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
        pendingSubscription.reject(reason);
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
          pendingSubscription.reject(pendingSubscription.signal.reason);
        } else {
          pendingSubscription.start(channel);
        }
      }
      set(pendingAblySubscriptions$, []);
    }

    L.debug(`Realtime connected, subscribed to ${channelName}`);
  },
);

export const setAblyLoop$ = command(
  async (
    { get, set },
    topic: string,
    loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();

    const runWithChannel = async (channel: RealtimeChannel) => {
      // No implicit prime on subscribe. Callers whose loop body sets up
      // baseline state (voice-chat session instructions, connector
      // `initialUpdatedAt`) must run the body themselves before calling this.
      // Chat / queue / slack subscribers don't need a baseline because their
      // data is fetched through separate computeds, and the implicit prime
      // fanned out through multiple run/message channels caused duplicate
      // refetches on every route change.

      let deferred = createDeferredPromise(signal);

      const pokeLoop = () => {
        deferred.resolve(true);
        deferred = createDeferredPromise(signal);
      };

      const callback = (message: InboundMessage) => {
        L.debug("got message from topic", topic, message);
        pokeLoop();
      };
      // The browser may throttle or suspend this tab in the background, which
      // can drop the Ably connection or leave us unaware of missed events.
      // When the tab becomes visible again, poke the loop so it re-runs once
      // and resyncs state with the server.
      const onVisibilityChange = () => {
        if (document.visibilityState !== "visible") {
          return;
        }
        L.debug("tab visible, poking loop", topic);
        pokeLoop();
      };
      document.addEventListener("visibilitychange", onVisibilityChange, {
        signal,
      });
      set(subscriberPokeRegistry$, (prev) => {
        const next = new Set(prev);
        next.add(pokeLoop);
        return next;
      });
      signal.addEventListener("abort", () => {
        set(subscriberPokeRegistry$, (prev) => {
          const next = new Set(prev);
          next.delete(pokeLoop);
          return next;
        });
        channel.unsubscribe(topic, callback);
      });
      await channel.subscribe(topic, callback);
      signal.throwIfAborted();
      L.debug("subscribed to topic: " + topic);

      while (!signal.aborted) {
        await deferred.promise;
        signal.throwIfAborted();

        // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
        try {
          const done = await set(loopCommand$, signal);
          signal.throwIfAborted();
          if (done) {
            channel.unsubscribe(topic, callback);
            return;
          }
        } catch (error) {
          throwIfAbort(error);
          L.warn(`transient error in ably notification`, error);
        }
      }
    };

    const channel = get(internalUserChannel$);
    if (channel) {
      await runWithChannel(channel);
      signal.throwIfAborted();
      return;
    }

    const startDeferred = createDeferredPromise<void>(signal);
    let loopPromise: Promise<void> | null = null;
    const pendingSubscription: PendingAblySubscription = {
      topic,
      signal,
      start: (pendingChannel) => {
        if (startDeferred.settled()) {
          return;
        }
        loopPromise = runWithChannel(pendingChannel);
        startDeferred.resolve();
      },
      reject: (reason?: unknown) => {
        if (!startDeferred.settled()) {
          startDeferred.reject(reason);
        }
      },
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

    await startDeferred.promise.finally(() => {
      signal.removeEventListener("abort", removePendingSubscription);
    });
    signal.throwIfAborted();
    if (!loopPromise) {
      throw new Error("realtime subscription did not start");
    }
    await loopPromise;
    signal.throwIfAborted();
  },
);
