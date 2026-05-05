// The current file still contains .cache and .zyn only because it is currently used for testing purposes,
// and there hasn't been time to adjust the paradigms within this file yet.
// In the long term, this file should also stop using .cache and .zyn.
// confirmed by ethan@vm0.ai
// oxlint-disable promise/prefer-await-to-then
/**
 * Mock ably module for tests.
 *
 * Provides a fake Realtime client that immediately "connects" and a fake
 * channel that records subscribe/unsubscribe calls. Test code can call
 * `triggerAblyEvent(topic)` to fire all callbacks registered for a topic,
 * simulating a server-side publish.
 *
 * `triggerAblyReconnect()` fires a second `connected` event on every
 * Realtime instance so tests can exercise the reconnect-replay path in
 * `setupRealtime$`.
 *
 * The mock also invokes the `authCallback` passed to the `Realtime`
 * constructor once on construction (simulating Ably's initial auth request)
 * and exposes `triggerAblyReauth()` + `getAuthTokenHistory()` so tests can
 * assert that renewals fetch a fresh `TokenRequest` rather than reusing a
 * cached one.
 */

type Callback = (message: { name: string; data: null }) => void;
type ConnectionListener = () => void;

type AuthCallbackError = string | { message?: string } | null;
type AuthCallbackToken = unknown;
type AuthCallback = (
  params: unknown,
  cb: (error: AuthCallbackError, token: AuthCallbackToken) => void,
) => void;

type FailedStateChange = { reason?: { message?: string } };
type ConnectionEventListener = (stateChange?: FailedStateChange) => void;

const subscriptions = new Map<string, Set<Callback>>();

let capturedAuthCallback: AuthCallback | null = null;
let tokenBodies: AuthCallbackToken[] = [];
let connectedListener: ConnectionEventListener | null = null;
let failedListener: ConnectionEventListener | null = null;
let hasConnected = false;
let failedStateChange: FailedStateChange | null = null;

/**
 * Fire all callbacks subscribed to `topic`. Call this from test helpers
 * to simulate a server-side Ably publish.
 */
export function triggerAblyEvent(topic: string): void {
  const cbs = subscriptions.get(topic);
  if (cbs) {
    for (const cb of cbs) {
      cb({ name: topic, data: null });
    }
  }
}

/**
 * Re-invoke the captured `authCallback`, simulating Ably's proactive token
 * renewal. Resolves with the token body the callback returned.
 */
export function triggerAblyReauth(): Promise<AuthCallbackToken> {
  if (!capturedAuthCallback) {
    throw new Error("triggerAblyReauth called before Realtime was constructed");
  }
  return invokeAuthCallback(capturedAuthCallback);
}

/**
 * Token bodies captured from every `authCallback` invocation, in order.
 * Tests use this to assert renewals fetch fresh tokens.
 */
export function getAuthTokenHistory(): readonly AuthCallbackToken[] {
  return tokenBodies;
}

/** Reset all subscriptions and captured auth state between tests. */
export function resetAblySubscriptions(): void {
  subscriptions.clear();
  capturedAuthCallback = null;
  tokenBodies = [];
  connectedListener = null;
  failedListener = null;
  hasConnected = false;
  failedStateChange = null;
  connectedListeners.clear();
}

/** Debug: check if a topic has active subscriptions. */
export function hasSubscription(topic: string): boolean {
  const cbs = subscriptions.get(topic);
  return cbs !== undefined && cbs.size > 0;
}

/**
 * Fire a `connected` event on every active Realtime instance to simulate
 * Ably re-establishing the connection after a network blip. Exercised by
 * `setupRealtime$`'s `connection.on("connected")` registry walk so every
 * active `setAblyLoop$` subscriber refetches state.
 */
export function triggerAblyReconnect(): void {
  for (const listener of connectedListeners) {
    listener();
  }
}

const connectedListeners = new Set<ConnectionListener>();

function invokeAuthCallback(cb: AuthCallback): Promise<AuthCallbackToken> {
  const deferred = Promise.withResolvers<AuthCallbackToken>();
  cb({}, (error, token) => {
    if (error) {
      const message =
        typeof error === "string" ? error : (error.message ?? "auth error");
      deferred.reject(new Error(message));
      return;
    }
    tokenBodies.push(token);
    deferred.resolve(token);
  });
  return deferred.promise;
}

const fakeChannel = {
  // Mirror real Ably: subscribe is async (server roundtrip) and the server
  // won't deliver events to this callback until the subscription has been
  // confirmed. Register the callback only after the returned promise
  // resolves so tests don't accidentally race with a callback that fires
  // before the subscribe await in consumer code has returned.
  async subscribe(topic: string, callback: Callback): Promise<void> {
    await Promise.resolve();
    let cbs = subscriptions.get(topic);
    if (!cbs) {
      cbs = new Set();
      subscriptions.set(topic, cbs);
    }
    cbs.add(callback);
  },
  unsubscribe(topic: string, callback: Callback): void {
    const cbs = subscriptions.get(topic);
    if (cbs) {
      cbs.delete(callback);
    }
  },
};

export class Realtime {
  auth = { clientId: "test-user-123" };
  connection = {
    once(event: string, callback: ConnectionEventListener) {
      if (event === "connected") {
        if (hasConnected) {
          queueMicrotask(() => {
            callback();
          });
        } else {
          connectedListener = callback;
        }
      } else if (event === "failed") {
        if (failedStateChange) {
          const stateChange = failedStateChange;
          queueMicrotask(() => {
            callback(stateChange);
          });
        } else {
          failedListener = callback;
        }
      }
    },
    on(event: string, callback: ConnectionListener) {
      if (event === "connected") {
        connectedListeners.add(callback);
      }
    },
  };
  channels = {
    get(_name: string) {
      return fakeChannel;
    },
  };

  constructor(config?: { authCallback?: AuthCallback }) {
    if (config?.authCallback) {
      capturedAuthCallback = config.authCallback;
      invokeAuthCallback(config.authCallback)
        .then(() => {
          hasConnected = true;
          const listener = connectedListener;
          connectedListener = null;
          if (listener) {
            queueMicrotask(() => {
              listener();
            });
          }
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          failedStateChange = { reason: { message } };
          const listener = failedListener;
          failedListener = null;
          if (listener) {
            const stateChange = failedStateChange;
            queueMicrotask(() => {
              listener(stateChange);
            });
          }
        });
    } else {
      queueMicrotask(() => {
        hasConnected = true;
        const listener = connectedListener;
        connectedListener = null;
        if (listener) {
          listener();
        }
      });
    }
  }

  close() {
    // no-op
  }
}

export type RealtimeChannel = typeof fakeChannel;
export type InboundMessage = { name: string; data: unknown };
