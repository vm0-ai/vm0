import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import type { SharedDatabaseConnectionStatus } from "./protocol.ts";

export interface SharedDatabaseBridge {
  registerTab(signal: AbortSignal): Promise<void>;
  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>>;
  reloadComputed(computedKey: ComputedKey): void;
  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>>;
}

export interface SharedDatabaseBridgeEvents {
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
