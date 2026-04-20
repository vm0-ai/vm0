import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import { createDeferredPromise, throwIfAbort } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("Realtime");
// ---------------------------------------------------------------------------
// Ably client singleton
// ---------------------------------------------------------------------------

const internalUserChannel$ = state<RealtimeChannel | null>(null);

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
  let resolve: () => void = () => {};
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

export const awaitRealtimeReady$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    let deferred = get(realtimeReadyDeferred$);
    if (!deferred) {
      deferred = createReadyDeferred();
      set(realtimeReadyDeferred$, deferred);
    }
    const readyPromise = deferred.promise;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
      readyPromise
        .then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        })
        .catch(reject);
    });
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

    // Verify the token endpoint works before loading Ably
    await accept(client.create({ body: {} }), [200], {
      toast: false,
    });
    signal.throwIfAborted();

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

    ably.connection.once("connected", () => {
      deferred.resolve(true);
    });
    ably.connection.once("failed", (stateChange) => {
      deferred.reject(
        new Error(
          `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
        ),
      );
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

    const done = await set(loopCommand$, signal);
    if (done) {
      return;
    }

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
    signal.addEventListener("abort", () => {
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
