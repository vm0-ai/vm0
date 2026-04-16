import { command, computed, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core";
import { Realtime, type RealtimeChannel, type InboundMessage } from "ably";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { IN_VITEST } from "../env.ts";
import {
  createDeferredPromise,
  FIB_DELAYS_MS,
  MAX_LOOP_COUNT_IN_TEST,
  setLoop,
  throwIfAbort,
} from "./utils.ts";
import { logger } from "./log.ts";
import { delay } from "signal-timers";

const L = logger("Realtime");
// ---------------------------------------------------------------------------
// Ably client singleton
// ---------------------------------------------------------------------------

const internalUserChannel$ = state<RealtimeChannel | null>(null);

export const realtimeChannel$ = computed((get) => {
  return get(internalUserChannel$);
});

/**
 * Initialize the Ably realtime client and subscribe to the user's channel.
 * Call once during app bootstrap, after Clerk auth is ready.
 */
export const setupRealtime$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (IN_VITEST) {
      return;
    }

    const createClient = get(zeroClient$);
    const client = createClient(platformRealtimeTokenContract);

    // Verify the token endpoint works before loading Ably
    await accept(client.create({ body: {} }), [200], {
      toast: false,
    });
    signal.throwIfAborted();

    const token = await accept(
      client.create({ body: {}, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    const ably = new Realtime({
      authCallback: (_params, callback) => {
        callback(null, token.body);
      },
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

    L.debug(`Realtime connected, subscribed to ${channelName}`);
  },
);

export const setAblyLoop$ = command(
  async (
    { get, set },
    topic: string,
    loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>,
    fallbackInterval: number,
    signal: AbortSignal,
  ) => {
    const channel = get(internalUserChannel$);
    if (!channel) {
      L.debug("fallback to interval");
      return setLoop(
        (sig) => {
          return set(loopCommand$, sig);
        },
        fallbackInterval,
        signal,
      );
    }

    const done = await set(loopCommand$, signal);
    if (done) {
      return;
    }

    let deferred = createDeferredPromise(signal);

    const callback = (message: InboundMessage) => {
      L.debug("got message from topic", topic, message);

      deferred.resolve(true);
    };
    signal.addEventListener("abort", () => {
      channel.unsubscribe(topic, callback);
    });
    await channel.subscribe(topic, callback);
    signal.throwIfAborted();

    let loopCount = 0;
    let fibIndex = 0;
    while (!signal.aborted) {
      if (IN_VITEST && loopCount++ > MAX_LOOP_COUNT_IN_TEST) {
        channel.unsubscribe(topic, callback);
        return;
      }

      // In VITEST, yield to the macrotask queue via setTimeout so React can
      // flush renders between iterations. We avoid delay(0, { signal }) because
      // signal-timers' Promise.race leaves an abandoned promiseFromSignal that
      // rejects as an unhandled rejection when the abort signal fires during
      // afterEach cleanup.
      await (IN_VITEST
        ? new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          })
        : deferred.promise);
      signal.throwIfAborted();

      deferred = createDeferredPromise(signal);

      // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
      try {
        const done = await set(loopCommand$, signal);
        fibIndex = 0;
        if (done) {
          channel.unsubscribe(topic, callback);
          return;
        }
      } catch (error) {
        throwIfAbort(error);
        const backoff =
          FIB_DELAYS_MS[Math.min(fibIndex, FIB_DELAYS_MS.length - 1)] ?? 60_000;
        L.warn(
          `setAblyLoop: transient error (attempt ${fibIndex + 1}), retrying in ${backoff}ms`,
          error,
        );
        fibIndex++;
        await (IN_VITEST
          ? new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            })
          : delay(backoff, { signal }));
      }
    }
  },
);
