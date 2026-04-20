/**
 * Mock ably module for tests.
 *
 * Provides a fake Realtime client that immediately "connects" and a fake
 * channel that records subscribe/unsubscribe calls. Test code can call
 * `triggerAblyEvent(topic)` to fire all callbacks registered for a topic,
 * simulating a server-side publish.
 *
 * The mock also invokes the `authCallback` passed to the `Realtime`
 * constructor once on construction (simulating Ably's initial auth request)
 * and exposes `triggerAblyReauth()` + `getAuthTokenHistory()` so tests can
 * assert that renewals fetch a fresh `TokenRequest` rather than reusing a
 * cached one.
 */

type Callback = (message: { name: string; data: null }) => void;

type AuthCallbackError = string | { message?: string } | null;
type AuthCallbackToken = unknown;
type AuthCallback = (
  params: unknown,
  cb: (error: AuthCallbackError, token: AuthCallbackToken) => void,
) => void;

const subscriptions = new Map<string, Set<Callback>>();

let capturedAuthCallback: AuthCallback | null = null;
let tokenBodies: AuthCallbackToken[] = [];
let connectedListener: (() => void) | null = null;
let hasConnected = false;

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
  hasConnected = false;
}

/** Debug: check if a topic has active subscriptions. */
export function hasSubscription(topic: string): boolean {
  const cbs = subscriptions.get(topic);
  return cbs !== undefined && cbs.size > 0;
}

function invokeAuthCallback(cb: AuthCallback): Promise<AuthCallbackToken> {
  return new Promise((resolve, reject) => {
    cb({}, (error, token) => {
      if (error) {
        const message =
          typeof error === "string" ? error : (error.message ?? "auth error");
        reject(new Error(message));
        return;
      }
      tokenBodies.push(token);
      resolve(token);
    });
  });
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
    once(event: string, callback: () => void) {
      if (event !== "connected") {
        return;
      }
      if (hasConnected) {
        queueMicrotask(callback);
      } else {
        connectedListener = callback;
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
      // Real Ably surfaces auth failures via connection state (which we
      // don't model here), so swallow rejections to keep test teardown
      // quiet when a fetch is aborted mid-flight.
      invokeAuthCallback(config.authCallback)
        .then(() => {
          hasConnected = true;
          const listener = connectedListener;
          connectedListener = null;
          if (listener) {
            queueMicrotask(listener);
          }
        })
        .catch(() => {});
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
