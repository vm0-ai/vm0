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
  ComputedKey,
  ListedComputerUseHost,
} from "../shared-database/computed-key.ts";
import type { SharedDatabaseConnectionStatus } from "../shared-database/protocol.ts";
import {
  reloadChatIndicatorsCounter$,
  reloadChatIndicatorsLocally$,
} from "./chat-thread-list-reload.ts";
import { installedSharedDatabaseBridge$ } from "./shared-database-bridge-state.ts";

const sharedDatabaseConnectionStatusState$ =
  state<SharedDatabaseConnectionStatus>("disconnected");

export const sharedDatabaseConnectionStatus$ = computed((get) => {
  return get(sharedDatabaseConnectionStatusState$);
});

export const setSharedDatabaseConnectionStatus$ = command(
  ({ set }, status: SharedDatabaseConnectionStatus): void => {
    set(sharedDatabaseConnectionStatusState$, status);
  },
);

const internalReloadComputerUseHostsFromWorker$ = state(0);

const reloadComputerUseHostsFromWorker$ = command(({ set }): void => {
  set(internalReloadComputerUseHostsFromWorker$, (value) => {
    return value + 1;
  });
});

export const reloadComputedFromWorker$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    if (computedKey === "chat-thread-indicators") {
      set(reloadChatIndicatorsLocally$);
      return;
    }
    set(reloadComputerUseHostsFromWorker$);
  },
);

export const chatThreadIndicatorsFromWorker$ = computed(
  async (get): Promise<ChatThreadIndicators> => {
    get(reloadChatIndicatorsCounter$);
    return await get(installedSharedDatabaseBridge$).getComputed(
      "chat-thread-indicators",
    );
  },
);

export const computerUseHostsFromWorker$ = computed(
  async (get): Promise<ListedComputerUseHost[]> => {
    get(internalReloadComputerUseHostsFromWorker$);
    return await get(installedSharedDatabaseBridge$).getComputed(
      "computer-use-hosts",
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
    return await get(installedSharedDatabaseBridge$).query(query, signal);
  },
);

// These are typed views of the same Query command, not separate operations.
// The bridge validates the selected dataset schema before the command returns.
export const queryChatEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatEventSharedDatabaseCommand;
export const queryChatThreadEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatThreadEventSharedDatabaseCommand;
