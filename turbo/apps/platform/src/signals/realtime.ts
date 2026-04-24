import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core/contracts/realtime";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { zeroClient$ } from "./api-client.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import { createDeferredPromise, throwIfAbort } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("Realtime");
// ---------------------------------------------------------------------------
// Ably client singleton
// ---------------------------------------------------------------------------

const internalUserChannel$ = state<RealtimeChannel | null>(null);

/**
 * Registry of loop-poke callbacks. Each `setAblyLoop$` call adds its
 * `pokeLoop` here on start and removes it on abort. `setupRealtime$`
 * listens on `connection.on("connected")` and walks this set on every
 * connect — fires once at bootstrap (registry empty, no-op) and again on
 * each reconnect so every active loop refetches state and catches up on
 * events missed during the disconnect.
 */
const subscriberPokeRegistry$ = state<ReadonlySet<() => void>>(new Set());

/**
 * Deferred promise that `setupRealtime$` resolves once the user-scoped Ably
 * channel has been established. Consumers started from the view layer
 * before bootstrap finishes realtime setup (e.g. the sidebar thread-list
 * daemon) can `await` this to avoid racing with the channel.
 */
interface ReadyDeferred {
  promise: Promise<void>;
  resolve: () => void;
}

const realtimeReadyDeferred$ = state<ReadyDeferred | null>(null);

function createReadyDeferred(): ReadyDeferred {
  const deferred = Promise.withResolvers<void>();
  return {
    promise: deferred.promise,
    resolve: () => {
      deferred.resolve();
    },
  };
}

export const awaitRealtimeReady$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    let deferred = get(realtimeReadyDeferred$);
    if (!deferred) {
      deferred = createReadyDeferred();
      set(realtimeReadyDeferred$, deferred);
    }
    const abortDeferred = Promise.withResolvers<void>();
    const onAbort = () => {
      abortDeferred.reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    await Promise.race([deferred.promise, abortDeferred.promise]).finally(
      () => {
        signal.removeEventListener("abort", onAbort);
      },
    );
    signal.throwIfAborted();
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

    signal.addEventListener("abort", () => {
      ably.close();
      set(internalUserChannel$, null);
    });

    const deferred = createDeferredPromise(signal);

    // Guard against the event firing after the deferred was already rejected
    // by signal-abort (tests using detachedSetupPage can tear down before
    // the mock's queued microtask runs).
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

    // Poke every active loop on each reconnect so they refetch state and
    // catch up on events missed during the disconnect. The first
    // "connected" event (bootstrap) fires before any `setAblyLoop$` has
    // registered, so the registry is empty and this is a no-op then.
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

    const existingReady = get(realtimeReadyDeferred$);
    const readyDeferred = existingReady ?? createReadyDeferred();
    if (!existingReady) {
      set(realtimeReadyDeferred$, readyDeferred);
    }
    readyDeferred.resolve();

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
    const channel = get(internalUserChannel$);
    if (!channel) {
      throw new Error("channel not estibilished");
    }

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
  },
);
