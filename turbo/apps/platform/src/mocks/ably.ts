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
 */

type Callback = (message: { name: string; data: null }) => void;
type ConnectionListener = () => void;

const subscriptions = new Map<string, Set<Callback>>();

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

/** Reset all subscriptions and mock connection state between tests. */
export function resetAblySubscriptions(): void {
  subscriptions.clear();
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
    once(event: string, callback: ConnectionListener) {
      if (event === "connected") {
        // Immediately fire connected
        queueMicrotask(callback);
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
  close() {
    // no-op
  }
}

export type RealtimeChannel = typeof fakeChannel;
export type InboundMessage = { name: string; data: unknown };
