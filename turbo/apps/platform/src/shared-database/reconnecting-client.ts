import { delay } from "signal-timers";
import {
  createChildAbortController,
  settle,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabaseHeartbeat,
} from "./bridge.ts";
import { SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME } from "./protocol.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
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
  readonly callback: () => void;
  readonly dataKey: SharedDatabaseDataKey;
  registeredGeneration: number | null;
}

class SharedDatabaseTransportTimeoutError extends Error {
  constructor() {
    super("Shared database worker transport timed out");
    this.name = "SharedDatabaseTransportTimeoutError";
  }
}

function isReconnectableTransportError(error: unknown): boolean {
  return (
    error instanceof SharedDatabaseTransportTimeoutError ||
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

function sameCredential(
  left: SharedDatabaseHeartbeat | null,
  right: SharedDatabaseHeartbeat,
): boolean {
  return (
    left?.identity.userId === right.identity.userId &&
    left.identity.orgId === right.identity.orgId
  );
}

function dataKeyMatchesIdentity(
  dataKey: SharedDatabaseDataKey,
  identity: SharedDatabaseIdentity,
): boolean {
  return dataKey.userId === identity.userId && dataKey.orgId === identity.orgId;
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
  ): Promise<void> {
    this.bindOwner(signal);
    const credentialChanged = !sameCredential(
      this.heartbeatRegistration,
      heartbeat,
    );
    this.heartbeatRegistration = heartbeat;
    if (credentialChanged) {
      for (const [id, subscription] of this.subscriptions) {
        if (!dataKeyMatchesIdentity(subscription.dataKey, heartbeat.identity)) {
          this.subscriptions.delete(id);
          this.subscriptionSignals.delete(id);
        } else {
          subscription.registeredGeneration = null;
        }
      }
    }

    const current = this.connection;
    if (!current) {
      const result = await settle(this.ensureConnection(), signal);
      if (result.ok) {
        return;
      }
      if (!isReconnectableTransportError(result.error)) {
        throw result.error;
      }
      await this.ensureConnection();
      return;
    }
    const result = await settle(
      this.renewConnection(current, heartbeat, credentialChanged),
      signal,
    );
    if (result.ok) {
      return;
    }
    if (!isReconnectableTransportError(result.error)) {
      throw result.error;
    }
    this.resetConnection(current, result.error);
    await this.ensureConnection();
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const connection = await this.ensureConnection();
    const result = await settle(connection.bridge.query(query, signal), signal);
    if (result.ok) {
      return result.value;
    }
    if (!(result.error instanceof SharedDatabaseTransportTimeoutError)) {
      throw result.error;
    }
    const recovered = await this.ensureConnection();
    return await recovered.bridge.query(query, signal);
  }

  async on(
    dataKey: SharedDatabaseDataKey,
    callback: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const identity = this.requireHeartbeatRegistration().identity;
    if (!dataKeyMatchesIdentity(dataKey, identity)) {
      throw new Error(
        "Shared database data key does not match client identity",
      );
    }
    const id = crypto.randomUUID();
    const subscription: DurableSubscription = {
      callback,
      dataKey,
      registeredGeneration: null,
    };
    this.subscriptions.set(id, subscription);
    this.subscriptionSignals.set(id, signal);
    const remove = (): void => {
      this.subscriptions.delete(id);
      this.subscriptionSignals.delete(id);
    };
    signal.addEventListener("abort", remove, { once: true });
    const result = await settle(
      this.connectAndRegister(subscription, signal),
      signal,
    );
    if (result.ok) {
      return;
    }
    if (result.error instanceof SharedDatabaseTransportTimeoutError) {
      const recovered = await this.ensureConnection();
      await this.registerSubscription(recovered, subscription, signal);
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
    registerSubscriptions: boolean,
  ): Promise<void> {
    await this.runControlRequest(
      connection.bridge.heartbeat(heartbeat, connection.controller.signal),
      connection,
    );
    if (registerSubscriptions) {
      await this.registerSubscriptions(connection);
    }
  }

  private async connectAndRegister(
    subscription: DurableSubscription,
    signal: AbortSignal,
  ): Promise<void> {
    const connection = await this.ensureConnection();
    await this.registerSubscription(connection, subscription, signal);
  }

  private async initializeConnection(
    connection: Connection,
    heartbeat: SharedDatabaseHeartbeat,
  ): Promise<void> {
    await this.runControlRequest(
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
    const result = await settle(
      this.runControlRequest(
        connection.bridge.on(
          subscription.dataKey,
          subscription.callback,
          signal,
        ),
        connection,
      ),
      signal,
    );
    if (result.ok) {
      subscription.registeredGeneration = connection.generation;
      return;
    }
    if (result.error instanceof SharedDatabaseTransportTimeoutError) {
      this.resetConnection(connection, result.error);
    }
    throw result.error;
  }

  private async runControlRequest<T>(
    work: Promise<T>,
    connection: Connection,
  ): Promise<T> {
    return await withTransportTimeout(
      work,
      this.controlRequestTimeoutMs,
      connection.controller.signal,
    );
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
    for (const subscription of this.subscriptions.values()) {
      subscription.registeredGeneration = null;
    }
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
