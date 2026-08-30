import { command, type Store } from "ccstate";

import { reloadChatIndicators$ } from "../signals/chat-thread-list-reload.ts";
import {
  installSharedDatabaseBridge$,
  setSharedDatabaseConnectionStatus$,
} from "../signals/shared-database.ts";
import { resolveApiBaseForTarget } from "../signals/api-base.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
} from "./bridge.ts";
import type {
  ChatThreadIndicators,
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import { MessagePortSharedDatabaseBridge } from "./message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "./message-port-server.ts";
import type { SharedDatabaseHeartbeatResult } from "./protocol.ts";
import type { TabId } from "./worker-context.ts";

class TestSharedDatabaseBridge implements SharedDatabaseBridge {
  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly afterHeartbeat?: () => Promise<void>,
  ) {}

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    const result = await this.bridge.heartbeat(heartbeat, signal);
    await this.afterHeartbeat?.();
    return result;
  }

  indicators(signal: AbortSignal): Promise<ChatThreadIndicators> {
    return this.bridge.indicators(signal);
  }

  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return this.bridge.query(query, signal);
  }

  on(
    dataKey: SharedDatabaseDataKey,
    callback: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.bridge.on(dataKey, callback, signal);
  }
}

export const setupSharedWorkerTestBootstrap$ = command(
  (
    { set },
    signal: AbortSignal,
    afterWorkerHeartbeat?: () => Promise<void>,
  ): void => {
    const channel = new MessageChannel();
    new SharedDatabaseMessagePortServer(channel.port1, signal, {
      credentialStores: new Map<string, Store>(),
      credentialAbortControllers: new Map<string, AbortController>(),
      tabCredentialIds: new Map<TabId, string>(),
      tabHeartbeatAts: new Map<TabId, number>(),
    });
    const bridge = new MessagePortSharedDatabaseBridge(
      channel.port2,
      resolveApiBaseForTarget("api"),
      {
        authenticationRequired: () => {},
        indicatorsInvalidated: () => {
          set(reloadChatIndicators$);
        },
        reloadRequired: () => {
          globalThis.location.reload();
        },
        statusChanged: (status) => {
          set(setSharedDatabaseConnectionStatus$, status);
        },
      },
    );
    set(
      installSharedDatabaseBridge$,
      new TestSharedDatabaseBridge(bridge, afterWorkerHeartbeat),
    );
  },
);
