import type {
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
  ChatThreadIndicators,
} from "./data-key.ts";
import type {
  SharedDatabaseConnectionStatus,
  SharedDatabaseHeartbeatResult,
} from "./protocol.ts";

export interface SharedDatabaseHeartbeat {
  readonly token: SharedDatabaseIdentity["token"];
  readonly vercelProtectionBypass?: string;
}

export type SharedDatabaseChangeKind = "append" | "invalidate";
export type SharedDatabaseSubscriptionCallback = (
  kind: SharedDatabaseChangeKind,
) => void;

export interface SharedDatabaseBridge {
  heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult>;
  indicators(signal: AbortSignal): Promise<ChatThreadIndicators>;
  reloadIndicators(): void;
  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>>;
  on(
    dataKey: SharedDatabaseDataKey,
    callback: SharedDatabaseSubscriptionCallback,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SharedDatabaseBridgeEvents {
  readonly authenticationRequired: () => void;
  readonly indicatorsInvalidated: (payload: unknown) => void;
  readonly reloadRequired: () => void;
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
