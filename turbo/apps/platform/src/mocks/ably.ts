// The current file still contains .cache and .zyn only because it is currently used for testing purposes,
// and there hasn't been time to adjust the paradigms within this file yet.
// In the long term, this file should also stop using .cache and .zyn.
// confirmed by ethan@vm0.ai
// oxlint-disable promise/prefer-await-to-then
import { createDeferredPromise } from "../signals/utils.ts";

/**
 * Mock Ably module for tests.
 *
 * Each Realtime instance owns its connection and channel subscriptions so
 * tests can exercise replacement of a terminal client without the old client
 * clearing the new client's subscriptions when it closes.
 */

type Callback = (message: { name: string; data: unknown }) => void;
type ConnectionListener = () => void;

type AuthCallbackError = string | { message?: string } | null;
type AuthCallbackToken = unknown;
type AuthCallback = (
  params: unknown,
  cb: (error: AuthCallbackError, token: AuthCallbackToken) => void,
) => void;

type FailedStateChange = { reason?: { message?: string } };
type ConnectionEventListener = (stateChange?: FailedStateChange) => void;
type MockConnectionState = "connecting" | "connected" | "failed" | "closed";

let capturedAuthCallback: AuthCallback | null = null;
let tokenBodies: AuthCallbackToken[] = [];
let nextSubscribeError: Error | null = null;
const realtimeInstances = new Set<Realtime>();
const subscribeErrors = new Map<
  string,
  {
    readonly error: Error;
    readonly observed: ReturnType<typeof createDeferredPromise<void>>;
  }
>();

function invokeAuthCallback(cb: AuthCallback): Promise<AuthCallbackToken> {
  const deferred = createDeferredPromise<AuthCallbackToken>(
    AbortSignal.any([]),
  );
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

class FakeChannel {
  readonly subscriptions = new Map<string, Set<Callback>>();
  readonly channelSubscriptions = new Set<Callback>();

  constructor(private readonly connectionState: () => MockConnectionState) {}

  trigger(topic: string, data?: unknown): void {
    const message = { name: topic, data };
    const callbacks = this.subscriptions.get(topic);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(message);
      }
    }
    for (const callback of this.channelSubscriptions) {
      callback(message);
    }
  }

  hasSubscription(topic: string): boolean {
    return (this.subscriptions.get(topic)?.size ?? 0) > 0;
  }

  hasChannelSubscription(): boolean {
    return this.channelSubscriptions.size > 0;
  }

  clear(): void {
    this.subscriptions.clear();
    this.channelSubscriptions.clear();
  }

  // Mirror real Ably: subscribe registers the callback synchronously before
  // waiting for the channel attach to complete.
  async subscribe(
    topicOrCallback: string | Callback,
    callback?: Callback,
  ): Promise<void> {
    if (typeof topicOrCallback === "function") {
      this.channelSubscriptions.add(topicOrCallback);
    } else if (callback) {
      let callbacks = this.subscriptions.get(topicOrCallback);
      if (!callbacks) {
        callbacks = new Set();
        this.subscriptions.set(topicOrCallback, callbacks);
      }
      callbacks.add(callback);
    }

    await Promise.resolve();
    if (this.connectionState() === "closed") {
      throw new Error("Connection closed");
    }
    if (typeof topicOrCallback === "string") {
      const failure = subscribeErrors.get(topicOrCallback);
      if (failure) {
        subscribeErrors.delete(topicOrCallback);
        failure.observed.resolve();
        throw failure.error;
      }
    }
    if (nextSubscribeError) {
      const error = nextSubscribeError;
      nextSubscribeError = null;
      throw error;
    }
  }

  unsubscribe(topicOrCallback: string | Callback, callback?: Callback): void {
    if (typeof topicOrCallback === "function") {
      this.channelSubscriptions.delete(topicOrCallback);
      return;
    }
    if (callback) {
      this.subscriptions.get(topicOrCallback)?.delete(callback);
    }
  }
}

export class Realtime {
  readonly auth = { clientId: "test-user-123" };
  readonly channel: FakeChannel;
  readonly connection: {
    state: MockConnectionState;
    once: (event: string, callback: ConnectionEventListener) => void;
    on: (event: string, callback: ConnectionListener) => void;
  };
  readonly channels: { get: (_name: string) => FakeChannel };

  private readonly connectedOnceListeners = new Set<ConnectionEventListener>();
  private readonly failedOnceListeners = new Set<ConnectionEventListener>();
  private readonly connectedListeners = new Set<ConnectionListener>();

  constructor(config?: { authCallback?: AuthCallback }) {
    this.connection = {
      state: "connecting",
      once: (event, callback) => {
        if (event === "connected") {
          if (this.connection.state === "connected") {
            queueMicrotask(callback);
          } else {
            this.connectedOnceListeners.add(callback);
          }
          return;
        }
        if (event === "failed") {
          if (this.connection.state === "failed") {
            queueMicrotask(() => {
              callback({ reason: { message: "connection failed" } });
            });
          } else {
            this.failedOnceListeners.add(callback);
          }
        }
      },
      on: (event, callback) => {
        if (event === "connected") {
          this.connectedListeners.add(callback);
        }
      },
    };
    this.channel = new FakeChannel(() => {
      return this.connection.state;
    });
    this.channels = {
      get: (_name) => {
        return this.channel;
      },
    };
    realtimeInstances.add(this);

    if (config?.authCallback) {
      capturedAuthCallback = config.authCallback;
      invokeAuthCallback(config.authCallback)
        .then(() => {
          this.connect();
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.fail(message);
        });
      return;
    }
    queueMicrotask(() => {
      this.connect();
    });
  }

  close(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.connection.state = "closed";
    this.channel.clear();
    this.connectedOnceListeners.clear();
    this.failedOnceListeners.clear();
    this.connectedListeners.clear();
    realtimeInstances.delete(this);
  }

  fail(message: string): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.connection.state = "failed";
    this.channel.clear();
    const stateChange = { reason: { message } };
    for (const listener of this.failedOnceListeners) {
      listener(stateChange);
    }
    this.failedOnceListeners.clear();
  }

  reconnect(): void {
    if (this.connection.state !== "connected") {
      return;
    }
    for (const listener of this.connectedListeners) {
      listener();
    }
  }

  private connect(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.connection.state = "connected";
    for (const listener of this.connectedOnceListeners) {
      listener();
    }
    this.connectedOnceListeners.clear();
    for (const listener of this.connectedListeners) {
      listener();
    }
  }
}

/** Fire a server-side publish on every connected Realtime instance. */
export function triggerAblyEvent(topic: string, data?: unknown): void {
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      realtime.channel.trigger(topic, data);
    }
  }
}

/** Re-invoke the newest client's auth callback to simulate token renewal. */
export function triggerAblyReauth(): Promise<AuthCallbackToken> {
  if (!capturedAuthCallback) {
    throw new Error("triggerAblyReauth called before Realtime was constructed");
  }
  return invokeAuthCallback(capturedAuthCallback);
}

/** Token bodies returned by every successful auth callback invocation. */
export function getAuthTokenHistory(): readonly AuthCallbackToken[] {
  return tokenBodies;
}

/** Fire a reconnect event on every connected Realtime instance. */
export function triggerAblyReconnect(): void {
  for (const realtime of realtimeInstances) {
    realtime.reconnect();
  }
}

/** Put the newest connected client into Ably's terminal failed state. */
export function triggerAblyFailure(message = "connection failed"): void {
  let connectedRealtime: Realtime | null = null;
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      connectedRealtime = realtime;
    }
  }
  connectedRealtime?.fail(message);
}

/** Close every active client, including its channel subscriptions. */
export function triggerAblyConnectionClosed(): void {
  for (const realtime of realtimeInstances) {
    realtime.close();
  }
}

export function rejectNextAblySubscribe(message: string): void {
  nextSubscribeError = new Error(message);
}

export function rejectAblySubscribe(
  topic: string,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  const observed = createDeferredPromise<void>(signal);
  subscribeErrors.set(topic, { error: new Error(message), observed });
  return observed.promise;
}

/** Debug: check if a topic has an active subscription. */
export function hasSubscription(topic: string): boolean {
  for (const realtime of realtimeInstances) {
    if (realtime.channel.hasSubscription(topic)) {
      return true;
    }
  }
  return false;
}

/** Debug: check if a user channel has an active catch-all subscription. */
export function hasChannelSubscription(): boolean {
  for (const realtime of realtimeInstances) {
    if (realtime.channel.hasChannelSubscription()) {
      return true;
    }
  }
  return false;
}

/** Reset all subscriptions and captured auth state between tests. */
export function resetAblySubscriptions(): void {
  triggerAblyConnectionClosed();
  capturedAuthCallback = null;
  tokenBodies = [];
  nextSubscribeError = null;
  subscribeErrors.clear();
}

export type RealtimeChannel = FakeChannel;
export type InboundMessage = { name: string; data: unknown };
