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

type AuthCallbackError = string | { message?: string } | null;
type AuthCallbackToken = unknown;
type AuthCallback = (
  params: unknown,
  cb: (error: AuthCallbackError, token: AuthCallbackToken) => void,
) => void;

interface MockErrorInfo {
  readonly code?: number;
  readonly message?: string;
  readonly statusCode?: number;
}

export type MockConnectionState =
  | "closed"
  | "closing"
  | "connected"
  | "connecting"
  | "disconnected"
  | "failed"
  | "initialized"
  | "suspended";

interface MockConnectionStateChange {
  readonly current: MockConnectionState;
  readonly previous: MockConnectionState;
  readonly reason?: MockErrorInfo;
  readonly retryIn?: number;
}

type ConnectionEventListener = (stateChange: MockConnectionStateChange) => void;
type ConnectionOn = {
  (callback: ConnectionEventListener): void;
  (event: string, callback: ConnectionEventListener): void;
};
type ConnectionOff = {
  (callback: ConnectionEventListener): void;
  (event: string, callback: ConnectionEventListener): void;
};
type MockChannelState =
  | "attached"
  | "attaching"
  | "detached"
  | "detaching"
  | "failed"
  | "initialized"
  | "suspended";
interface MockChannelStateChange {
  readonly current: MockChannelState;
  readonly previous: MockChannelState;
  readonly reason?: MockErrorInfo;
}
type ChannelStateListener = (stateChange: MockChannelStateChange) => void;

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
  state: MockChannelState = "initialized";
  private readonly stateListeners = new Set<ChannelStateListener>();

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
    this.transition("detached");
  }

  fail(reason: MockErrorInfo): void {
    this.subscriptions.clear();
    this.channelSubscriptions.clear();
    this.transition("failed", reason);
  }

  suspend(reason: MockErrorInfo): void {
    this.transition("suspended", reason);
  }

  reconnect(): void {
    if (this.state !== "suspended") {
      return;
    }
    this.transition("attaching");
    this.transition("attached");
  }

  on(callback: ChannelStateListener): void {
    this.stateListeners.add(callback);
  }

  off(callback: ChannelStateListener): void {
    this.stateListeners.delete(callback);
  }

  private transition(state: MockChannelState, reason?: MockErrorInfo): void {
    const previous = this.state;
    this.state = state;
    const stateChange = { current: state, previous, reason };
    for (const listener of this.stateListeners) {
      listener(stateChange);
    }
  }

  // Mirror real Ably: subscribe registers the callback synchronously before
  // waiting for the channel attach to complete.
  async subscribe(
    topicOrCallback: string | Callback,
    callback?: Callback,
  ): Promise<void> {
    if (this.state === "initialized" || this.state === "detached") {
      this.transition("attaching");
    }
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
    if (this.state === "attaching") {
      this.transition("attached");
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
    on: ConnectionOn;
    off: ConnectionOff;
  };
  readonly channels: { get: (_name: string) => FakeChannel };

  private readonly connectedOnceListeners = new Set<ConnectionEventListener>();
  private readonly failedOnceListeners = new Set<ConnectionEventListener>();
  private readonly connectedListeners = new Set<ConnectionEventListener>();
  private readonly stateListeners = new Set<ConnectionEventListener>();

  constructor(config?: { authCallback?: AuthCallback }) {
    const on = (
      eventOrCallback: string | ConnectionEventListener,
      callback?: ConnectionEventListener,
    ): void => {
      if (typeof eventOrCallback === "function") {
        this.stateListeners.add(eventOrCallback);
        return;
      }
      if (eventOrCallback === "connected" && callback) {
        this.connectedListeners.add(callback);
      }
    };
    const off = (
      eventOrCallback: string | ConnectionEventListener,
      callback?: ConnectionEventListener,
    ): void => {
      if (typeof eventOrCallback === "function") {
        this.stateListeners.delete(eventOrCallback);
        return;
      }
      if (eventOrCallback === "connected" && callback) {
        this.connectedListeners.delete(callback);
      }
    };
    this.connection = {
      state: "connecting",
      once: (event, callback) => {
        if (event === "connected") {
          if (this.connection.state === "connected") {
            queueMicrotask(() => {
              callback({ current: "connected", previous: "connected" });
            });
          } else {
            this.connectedOnceListeners.add(callback);
          }
          return;
        }
        if (event === "failed") {
          if (this.connection.state === "failed") {
            queueMicrotask(() => {
              callback({
                current: "failed",
                previous: "failed",
                reason: { message: "connection failed" },
              });
            });
          } else {
            this.failedOnceListeners.add(callback);
          }
        }
      },
      on,
      off,
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
    this.transition("closing");
    this.channel.clear();
    this.transition("closed");
    this.connectedOnceListeners.clear();
    this.failedOnceListeners.clear();
    this.connectedListeners.clear();
    this.stateListeners.clear();
    realtimeInstances.delete(this);
  }

  fail(message: string): void {
    if (this.connection.state === "closed") {
      return;
    }
    const reason = { message };
    this.channel.fail(reason);
    this.transition("failed", reason);
  }

  reconnect(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.channel.reconnect();
    this.transition("connected");
  }

  transitionTo(
    state: "connected" | "disconnected" | "suspended",
    reason: MockErrorInfo = {},
    retryIn?: number,
  ): void {
    if (this.connection.state === "closed") {
      return;
    }
    if (state === "suspended") {
      this.channel.suspend(reason);
    } else if (state === "connected") {
      this.channel.reconnect();
    }
    this.transition(state, reason, retryIn);
  }

  private connect(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.transition("connected");
  }

  private transition(
    state: MockConnectionState,
    reason?: MockErrorInfo,
    retryIn?: number,
  ): void {
    const previous = this.connection.state;
    this.connection.state = state;
    const stateChange = { current: state, previous, reason, retryIn };
    for (const listener of this.stateListeners) {
      listener(stateChange);
    }
    if (state === "connected") {
      for (const listener of this.connectedOnceListeners) {
        listener(stateChange);
      }
      this.connectedOnceListeners.clear();
      for (const listener of this.connectedListeners) {
        listener(stateChange);
      }
    }
    if (state === "failed") {
      for (const listener of this.failedOnceListeners) {
        listener(stateChange);
      }
      this.failedOnceListeners.clear();
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

export function triggerAblyConnectionState(
  state: "connected" | "disconnected" | "suspended",
  options: {
    readonly code?: number;
    readonly message?: string;
    readonly retryIn?: number;
    readonly statusCode?: number;
  } = {},
): void {
  let activeRealtime: Realtime | null = null;
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state !== "closed") {
      activeRealtime = realtime;
    }
  }
  activeRealtime?.transitionTo(
    state,
    {
      code: options.code,
      message: options.message,
      statusCode: options.statusCode,
    },
    options.retryIn,
  );
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
