import { delay } from "signal-timers";
import {
  createChildAbortController,
  createDeferredPromise,
  settle,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
  SharedDatabaseSubscriptionCallback,
} from "./bridge.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseHeartbeatResult,
} from "./protocol.ts";
import type {
  ChatThreadIndicators,
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";

const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

interface ReconnectingSharedDatabaseBridgeOptions {
  readonly createBridge: (
    events: SharedDatabaseBridgeEvents,
  ) => SharedDatabaseBridge;
  readonly events: SharedDatabaseBridgeEvents;
  readonly controlRequestTimeoutMs?: number;
}

interface Connection {
  readonly bridge: SharedDatabaseBridge;
  readonly controller: AbortController;
  readonly generation: number;
}

interface DurableSubscription {
  readonly callback: SharedDatabaseSubscriptionCallback;
  readonly dataKey: SharedDatabaseDataKey;
  registeredGeneration: number | null;
  registrationController: AbortController | null;
}

class SharedDatabaseTransportTimeoutError extends Error {
  constructor() {
    super("Shared database worker transport timed out");
    this.name = "SharedDatabaseTransportTimeoutError";
  }
}

export type SharedDatabaseTransportRecovery = "reconnect" | "reload";

export class SharedDatabaseTransportError extends Error {
  private recoveryPromise: Promise<SharedDatabaseTransportRecovery> | null =
    null;
  private reloadRequested = false;

  constructor(
    message: string,
    private readonly resolveRecovery: () => Promise<SharedDatabaseTransportRecovery>,
  ) {
    super(message);
    this.name = "SharedDatabaseTransportError";
  }

  recover(): Promise<SharedDatabaseTransportRecovery> {
    this.recoveryPromise ??= this.resolveRecovery();
    return this.recoveryPromise;
  }

  claimReload(): boolean {
    if (this.reloadRequested) {
      return false;
    }
    this.reloadRequested = true;
    return true;
  }
}

function isReconnectableTransportError(error: unknown): boolean {
  return (
    error instanceof SharedDatabaseTransportTimeoutError ||
    error instanceof SharedDatabaseTransportError ||
    (error instanceof Error &&
      error.name === SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME)
  );
}

async function withTransportTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const timeoutController = createChildAbortController(signal);
  const timeout = (async (): Promise<never> => {
    await delay(timeoutMs, { signal: timeoutController.signal });
    throw new SharedDatabaseTransportTimeoutError();
  })();
  return await withCleanup(Promise.race([work, timeout]), () => {
    timeoutController.abort(
      new DOMException("Transport request completed", "AbortError"),
    );
  });
}

export class ReconnectingSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly subscriptions = new Map<string, DurableSubscription>();
  private readonly subscriptionSignals = new Map<string, AbortSignal>();
  private readonly controlRequestTimeoutMs: number;
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private heartbeatRegistration: SharedDatabaseHeartbeat | null = null;
  private ownerSignal: AbortSignal | null = null;
  private generation = 0;

  constructor(
    private readonly options: ReconnectingSharedDatabaseBridgeOptions,
  ) {
    this.controlRequestTimeoutMs =
      options.controlRequestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
  }

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.bindOwner(signal);
    this.heartbeatRegistration = heartbeat;

    const connectionToRenew = this.connection;
    await this.runWithReconnect(async (connection) => {
      if (connection === connectionToRenew) {
        await this.renewConnection(connection, heartbeat);
      }
    }, signal);
    return { clientReconnected: false };
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return await this.runWithReconnect(async (connection) => {
      return await this.runTransportRequest(
        connection.bridge.query(query, signal),
        connection,
      );
    }, signal);
  }

  async indicators(signal: AbortSignal): Promise<ChatThreadIndicators> {
    return await this.runWithReconnect(async (connection) => {
      return await this.runTransportRequest(
        connection.bridge.indicators(signal),
        connection,
      );
    }, signal);
  }

  reloadIndicators(): void {
    const connection = this.connection;
    if (!connection) {
      throw new Error("Shared database worker is not connected");
    }
    connection.bridge.reloadIndicators();
  }

  async on(
    dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.requireHeartbeatRegistration();
    const id = crypto.randomUUID();
    const subscription: DurableSubscription = {
      callback,
      dataKey,
      registeredGeneration: null,
      registrationController: null,
    };
    this.subscriptions.set(id, subscription);
    this.subscriptionSignals.set(id, signal);
    const remove = (): void => {
      this.subscriptions.delete(id);
      this.subscriptionSignals.delete(id);
    };
    signal.addEventListener("abort", remove, { once: true });
    const result = await settle(
      this.runWithReconnect(async (connection) => {
        await this.registerSubscription(connection, subscription, signal);
      }, signal),
      signal,
    );
    if (result.ok) {
      return;
    }
    signal.removeEventListener("abort", remove);
    remove();
    throw result.error;
  }

  private bindOwner(signal: AbortSignal): void {
    if (this.ownerSignal === signal) {
      return;
    }
    if (this.ownerSignal !== null) {
      throw new Error("Shared database bridge already has a lifecycle owner");
    }
    signal.throwIfAborted();
    this.ownerSignal = signal;
    signal.addEventListener(
      "abort",
      () => {
        this.subscriptions.clear();
        this.subscriptionSignals.clear();
        const connection = this.connection;
        if (connection) {
          this.resetConnection(connection, signal.reason, false);
        }
      },
      { once: true },
    );
  }

  private async ensureConnection(): Promise<Connection> {
    this.ownerSignal?.throwIfAborted();
    if (this.connection) {
      return this.connection;
    }
    if (this.connecting) {
      return await this.connecting;
    }
    const connecting = this.createConnection();
    this.connecting = connecting;
    return await withCleanup(connecting, () => {
      if (this.connecting === connecting) {
        this.connecting = null;
      }
    });
  }

  private async createConnection(): Promise<Connection> {
    const ownerSignal = this.requireOwnerSignal();
    const heartbeat = this.requireHeartbeatRegistration();
    const controller = createChildAbortController(ownerSignal);
    const generation = ++this.generation;
    this.options.events.statusChanged("connecting");
    const bridge = this.options.createBridge({
      authenticationRequired: () => {
        if (this.connection?.generation === generation) {
          this.options.events.authenticationRequired();
        }
      },
      indicatorsInvalidated: (payload) => {
        if (this.connection?.generation === generation) {
          this.options.events.indicatorsInvalidated(payload);
        }
      },
      reloadRequired: () => {
        if (this.connection?.generation === generation) {
          this.options.events.reloadRequired();
        }
      },
      statusChanged: (status) => {
        if (this.connection?.generation === generation) {
          this.options.events.statusChanged(status);
        }
      },
    });
    const connection = { bridge, controller, generation };
    this.connection = connection;
    const result = await settle(
      this.initializeConnection(connection, heartbeat),
      controller.signal,
    );
    if (!result.ok) {
      this.resetConnection(connection, result.error);
      throw result.error;
    }
    return connection;
  }

  private async renewConnection(
    connection: Connection,
    heartbeat: SharedDatabaseHeartbeat,
  ): Promise<void> {
    const result = await this.runTransportRequest(
      connection.bridge.heartbeat(heartbeat, connection.controller.signal),
      connection,
    );
    if (result.clientReconnected) {
      this.invalidateSubscriptionRegistrations(
        new DOMException("Shared database client renewed", "AbortError"),
      );
    }
    if (result.clientReconnected) {
      await this.registerSubscriptions(connection);
    }
  }

  private async initializeConnection(
    connection: Connection,
    heartbeat: SharedDatabaseHeartbeat,
  ): Promise<void> {
    await this.runTransportRequest(
      connection.bridge.heartbeat(heartbeat, connection.controller.signal),
      connection,
    );
    await this.registerSubscriptions(connection);
  }

  private async registerSubscriptions(connection: Connection): Promise<void> {
    for (const [id, subscription] of this.subscriptions) {
      const signal = this.subscriptionSignals.get(id);
      if (signal) {
        await this.registerSubscription(connection, subscription, signal);
      }
    }
  }

  private async registerSubscription(
    connection: Connection,
    subscription: DurableSubscription,
    subscriptionSignal: AbortSignal,
  ): Promise<void> {
    if (
      subscriptionSignal.aborted ||
      subscription.registeredGeneration === connection.generation
    ) {
      return;
    }
    const signal = AbortSignal.any([
      subscriptionSignal,
      connection.controller.signal,
    ]);
    const registrationController = createChildAbortController(signal);
    subscription.registrationController = registrationController;
    const result = await settle(
      this.runTransportRequest(
        connection.bridge.on(
          subscription.dataKey,
          subscription.callback,
          registrationController.signal,
        ),
        connection,
      ),
      registrationController.signal,
    );
    if (!result.ok) {
      registrationController.abort(result.error);
      if (subscription.registrationController === registrationController) {
        subscription.registrationController = null;
      }
      throw result.error;
    }
    subscription.registeredGeneration = connection.generation;
  }

  private async runTransportRequest<T>(
    work: Promise<T>,
    connection: Connection,
  ): Promise<T> {
    return await withTransportTimeout(
      work,
      this.controlRequestTimeoutMs,
      connection.controller.signal,
    );
  }

  private async runWithReconnect<T>(
    operation: (connection: Connection) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let attemptedConnection: Connection | null = null;
    const run = async (): Promise<T> => {
      attemptedConnection = await this.ensureConnection();
      return await operation(attemptedConnection);
    };
    const first = await settle(run(), signal);
    if (first.ok) {
      return first.value;
    }
    if (!isReconnectableTransportError(first.error)) {
      throw first.error;
    }
    if (attemptedConnection) {
      this.resetConnection(attemptedConnection, first.error);
    }
    await this.waitForTransportRecovery(first.error, signal);

    attemptedConnection = null;
    const second = await settle(run(), signal);
    if (second.ok) {
      return second.value;
    }
    if (isReconnectableTransportError(second.error)) {
      if (attemptedConnection) {
        this.resetConnection(attemptedConnection, second.error);
      }
      await this.waitForTransportRecovery(second.error, signal);
    }
    throw second.error;
  }

  private async waitForTransportRecovery(
    failure: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (!(failure instanceof SharedDatabaseTransportError)) {
      return;
    }
    const waitController = createChildAbortController(signal);
    const aborted = createDeferredPromise<never>(waitController.signal);
    const recoveryWork = failure.recover();
    const recovery = await withCleanup(
      Promise.race([recoveryWork, aborted.promise]),
      () => {
        waitController.abort(
          new DOMException("Transport recovery wait completed", "AbortError"),
        );
      },
    );
    signal.throwIfAborted();
    if (recovery === "reconnect") {
      return;
    }
    if (failure.claimReload()) {
      this.options.events.reloadRequired();
    }
    await createDeferredPromise<never>(signal).promise;
  }

  private invalidateSubscriptionRegistrations(reason?: unknown): void {
    for (const subscription of this.subscriptions.values()) {
      this.invalidateSubscriptionRegistration(subscription, reason);
    }
  }

  private invalidateSubscriptionRegistration(
    subscription: DurableSubscription,
    reason?: unknown,
  ): void {
    if (reason !== undefined) {
      subscription.registrationController?.abort(reason);
    }
    subscription.registrationController = null;
    subscription.registeredGeneration = null;
  }

  private resetConnection(
    connection: Connection,
    reason: unknown,
    reportDisconnected = true,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = null;
    connection.controller.abort(reason);
    this.invalidateSubscriptionRegistrations();
    if (reportDisconnected && !this.ownerSignal?.aborted) {
      this.options.events.statusChanged("disconnected");
    }
  }

  private requireHeartbeatRegistration(): SharedDatabaseHeartbeat {
    if (!this.heartbeatRegistration) {
      throw new Error("Shared database heartbeat is required first");
    }
    return this.heartbeatRegistration;
  }

  private requireOwnerSignal(): AbortSignal {
    if (!this.ownerSignal) {
      throw new Error("Shared database heartbeat is required first");
    }
    return this.ownerSignal;
  }
}
