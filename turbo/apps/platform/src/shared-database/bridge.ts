import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import type {
  SharedDatabaseConnectionStatus,
  SharedDatabaseHeartbeatResult,
} from "./protocol.ts";

export interface SharedDatabaseHeartbeat {
  readonly token: SharedDatabaseIdentity["token"];
  readonly vercelProtectionBypass?: string;
}

export interface SharedDatabaseBridge {
  heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult>;
  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>>;
  reloadComputed(computedKey: ComputedKey): void;
  setToken(
    recoveryId: string,
    token: string | null,
    signal: AbortSignal,
  ): Promise<void>;
  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>>;
}

export interface SharedDatabaseBridgeEvents {
  readonly authenticationRequired: (recoveryId: string) => void | Promise<void>;
  readonly databaseInvalidated: (
    dataKey: SharedDatabaseDataKey,
  ) => void | Promise<void>;
  readonly databaseReconnected: () => void | Promise<void>;
  readonly reloadRequired: () => void;
  readonly computedReloaded: (computedKey: ComputedKey) => void;
  readonly chatThreadReadCursorUpdated: (payload: unknown) => void;
  readonly statusChanged: (status: SharedDatabaseConnectionStatus) => void;
}

export interface SharedDatabasePortLike {
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}
