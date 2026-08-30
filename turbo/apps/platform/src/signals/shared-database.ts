import { command, computed, state, type Command } from "ccstate";
import type {
  ChatThreadIndicators,
  ChatEventDataKey,
  ChatThreadEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../shared-database/data-key.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
} from "../shared-database/bridge.ts";
import type { SharedDatabaseConnectionStatus } from "../shared-database/protocol.ts";
import { reloadChatIndicatorsCounter$ } from "./chat-thread-list-reload.ts";
import { rootSignal$ } from "./root-signal.ts";

const sharedDatabaseBridgeState$ = state<SharedDatabaseBridge | null>(null);
const sharedDatabaseConnectionStatusState$ =
  state<SharedDatabaseConnectionStatus>("disconnected");

export const sharedDatabaseConnectionStatus$ = computed((get) => {
  return get(sharedDatabaseConnectionStatusState$);
});

export const sharedDatabaseBridgeInstalled$ = computed((get): boolean => {
  return get(sharedDatabaseBridgeState$) !== null;
});

export const setSharedDatabaseConnectionStatus$ = command(
  ({ set }, status: SharedDatabaseConnectionStatus): void => {
    set(sharedDatabaseConnectionStatusState$, status);
  },
);

export const installSharedDatabaseBridge$ = command(
  ({ set }, bridge: SharedDatabaseBridge): void => {
    set(sharedDatabaseBridgeState$, bridge);
    set(sharedDatabaseConnectionStatusState$, "connecting");
  },
);

function requireBridge(
  bridge: SharedDatabaseBridge | null,
): SharedDatabaseBridge {
  if (!bridge) {
    throw new Error("Shared database bridge is not installed");
  }
  return bridge;
}

export const heartbeatSharedDatabase$ = command(
  async (
    { get },
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<void> => {
    await requireBridge(get(sharedDatabaseBridgeState$)).heartbeat(
      heartbeat,
      signal,
    );
  },
);

export const sharedDatabaseChatThreadIndicators$ = computed(
  async (get): Promise<ChatThreadIndicators> => {
    get(reloadChatIndicatorsCounter$);
    return await requireBridge(get(sharedDatabaseBridgeState$)).indicators(
      get(rootSignal$),
    );
  },
);

type QueryChatEventSharedDatabaseCommand = Command<
  Promise<SharedDatabaseQueryResult<ChatEventDataKey>>,
  [SharedDatabaseQuery<ChatEventDataKey>, AbortSignal]
>;

type QueryChatThreadEventSharedDatabaseCommand = Command<
  Promise<SharedDatabaseQueryResult<ChatThreadEventDataKey>>,
  [SharedDatabaseQuery<ChatThreadEventDataKey>, AbortSignal]
>;

const querySharedDatabaseCommand$ = command(
  async (
    { get },
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await requireBridge(get(sharedDatabaseBridgeState$)).query(
      query,
      signal,
    );
  },
);

// These are typed views of the same Query command, not separate operations.
// The bridge validates the selected dataset schema before the command returns.
export const queryChatEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatEventSharedDatabaseCommand;
export const queryChatThreadEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatThreadEventSharedDatabaseCommand;

export const onSharedDatabase$ = command(
  async (
    { get },
    dataKey: SharedDatabaseDataKey,
    callback: () => void,
    signal: AbortSignal,
  ): Promise<void> => {
    await requireBridge(get(sharedDatabaseBridgeState$)).on(
      dataKey,
      callback,
      signal,
    );
  },
);
