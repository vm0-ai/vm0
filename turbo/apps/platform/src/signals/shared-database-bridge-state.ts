import { command, computed, state } from "ccstate";

import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
} from "../shared-database/bridge.ts";

const sharedDatabaseBridgeState$ = state<SharedDatabaseBridge | null>(null);

export const sharedDatabaseBridgeInstalled$ = computed((get): boolean => {
  return get(sharedDatabaseBridgeState$) !== null;
});

export const installedSharedDatabaseBridge$ = computed(
  (get): SharedDatabaseBridge => {
    const bridge = get(sharedDatabaseBridgeState$);
    if (!bridge) {
      throw new Error("Shared database bridge is not installed");
    }
    return bridge;
  },
);

export const installSharedDatabaseBridge$ = command(
  async (
    { set },
    bridge: SharedDatabaseBridge,
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<void> => {
    await bridge.heartbeat(heartbeat, signal);
    signal.throwIfAborted();
    set(sharedDatabaseBridgeState$, bridge);
  },
);

export const heartbeatSharedDatabase$ = command(
  async (
    { get },
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<void> => {
    await get(installedSharedDatabaseBridge$).heartbeat(heartbeat, signal);
  },
);

export const reloadSharedDatabaseIndicators$ = command(({ get }): void => {
  get(installedSharedDatabaseBridge$).reloadIndicators();
});
