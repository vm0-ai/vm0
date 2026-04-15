import { command, computed, state } from "ccstate";
import { platformRealtimeTokenContract } from "@vm0/core";
import {
  Realtime,
  type RealtimeChannel,
  type ErrorInfo,
  type TokenRequest,
  type TokenDetails,
} from "ably";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { IN_VITEST } from "../env.ts";
import { setLoop } from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("Realtime");

// ---------------------------------------------------------------------------
// Ably client singleton
// ---------------------------------------------------------------------------

const internalUserChannel$ = state<RealtimeChannel | null>(null);

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

    const fetchToken = () => {
      return accept(client.create({ body: {} }), [200], { toast: false });
    };

    type AblyCallbackFn = (
      error: ErrorInfo | string | null,
      tokenRequestOrDetails: TokenDetails | TokenRequest | string | null,
    ) => void;

    const resolveAblyToken = (callbackFn: AblyCallbackFn) => {
      fetchToken()
        .then((resp) => {
          callbackFn(null, resp.body);
        })
        .catch((error: unknown) => {
          callbackFn(
            error instanceof Error ? error.message : "Token request failed",
            null,
          );
        });
    };

    const ably = new Realtime({
      authCallback: (_params, callback) => {
        resolveAblyToken(callback);
      },
      autoConnect: true,
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15_000,
    });

    signal.addEventListener("abort", () => {
      ably.close();
      set(internalUserChannel$, null);
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      ably.connection.once("connected", () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      ably.connection.once("failed", (stateChange) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          new Error(
            `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
          ),
        );
      });
    });
    signal.throwIfAborted();

    // Subscribe to the user's channel (clientId is set by the token)
    const channelName = `user:${ably.auth.clientId}`;
    const channel = ably.channels.get(channelName);
    set(internalUserChannel$, channel);

    L.info(`Realtime connected, subscribed to ${channelName}`);
  },
);

// ---------------------------------------------------------------------------
// ablyNotify — drop-in replacement for setLoop
// ---------------------------------------------------------------------------

type NotifyBody = (signal: AbortSignal) => Promise<boolean> | boolean;

/**
 * Subscribe to `topic` on `channel` and invoke `body` on each message.
 * Resolves when `body` returns `true`, rejects on abort or subscribe failure.
 */
async function ablyChannelNotify(
  channel: RealtimeChannel,
  topic: string,
  body: NotifyBody,
  signal: AbortSignal,
): Promise<void> {
  // Run body once immediately to load initial data
  const done = await body(signal);
  if (done) {
    return;
  }

  // Subscribe to the specific topic on the user's channel and wait
  // for Ably signals to re-run body.
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };

    const messageHandler = () => {
      const result = body(signal);
      if (result instanceof Promise) {
        result
          .then((finished) => {
            if (finished) {
              cleanup();
              resolve();
            }
          })
          .catch((error: unknown) => {
            cleanup();
            reject(error);
          });
      } else if (result) {
        cleanup();
        resolve();
      }
    };

    channel
      .subscribe(topic, messageHandler)
      .catch((subscribeError: unknown) => {
        signal.removeEventListener("abort", onAbort);
        L.warn(
          `ablyNotify: failed to subscribe to topic "${topic}"`,
          subscribeError,
        );
        reject(subscribeError);
      });
    signal.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      signal.removeEventListener("abort", onAbort);
      channel.unsubscribe(topic, messageHandler);
    }
  });
}

/**
 * Module-level ablyNotify that reads the user channel from signal state.
 * This is the primary API used by feature code.
 *
 * Usage inside a command:
 *   const ablyNotify = get(ablyNotify$);
 *   await ablyNotify("thread:runId", body, 3000, signal);
 *
 * When Ably is connected, subscribes to the topic on the user channel.
 * Each message triggers `body`. Falls back to setLoop when Ably is
 * unavailable or in test environment.
 */
export const ablyNotify$ = computed((get) => {
  const channel = get(internalUserChannel$);

  return function ablyNotify(
    topic: string,
    body: NotifyBody,
    interval: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!channel) {
      return setLoop(body, interval, signal);
    }
    return ablyChannelNotify(channel, topic, body, signal);
  };
});
