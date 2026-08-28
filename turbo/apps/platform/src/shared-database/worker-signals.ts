import { command, state } from "ccstate";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { SharedDatabaseHeartbeat } from "./bridge.ts";
import type { SharedDatabaseHeartbeatResult } from "./protocol.ts";
import {
  SharedDatabaseWorkerRuntime,
  type WorkerClientEmitter,
} from "./worker-runtime.ts";

const workerRuntimeState$ = state<SharedDatabaseWorkerRuntime | null>(null);

interface SharedDatabaseWorkerHeartbeat extends SharedDatabaseHeartbeat {
  readonly apiBaseUrl: string;
  readonly emit?: WorkerClientEmitter;
}

function requireRuntime(
  runtime: SharedDatabaseWorkerRuntime | null,
): SharedDatabaseWorkerRuntime {
  if (!runtime) {
    throw new Error("Shared database worker is not bootstrapped");
  }
  return runtime;
}

export const bootstrapSharedDatabaseWorker$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    if (get(workerRuntimeState$)) {
      return;
    }
    set(workerRuntimeState$, new SharedDatabaseWorkerRuntime(signal));
  },
);

export const connectSharedDatabaseWorkerClient$ = command(
  ({ get }, clientId: string, emit: WorkerClientEmitter): void => {
    requireRuntime(get(workerRuntimeState$)).connectClient(clientId, emit);
  },
);

export const heartbeatSharedDatabaseWorker$ = command(
  async (
    { get },
    clientId: string,
    heartbeat: SharedDatabaseWorkerHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> => {
    signal.throwIfAborted();
    const result = await requireRuntime(get(workerRuntimeState$)).heartbeat(
      clientId,
      heartbeat.emit,
      heartbeat.identity,
      heartbeat.apiBaseUrl,
      heartbeat.vercelProtectionBypass,
    );
    signal.throwIfAborted();
    return result;
  },
);

export const disconnectSharedDatabaseWorkerClient$ = command(
  ({ get }, clientId: string): void => {
    requireRuntime(get(workerRuntimeState$)).disconnectClient(clientId);
  },
);

export const subscribeSharedDatabaseWorker$ = command(
  (
    { get },
    clientId: string,
    subscriptionId: string,
    dataKey: SharedDatabaseDataKey,
  ): void => {
    requireRuntime(get(workerRuntimeState$)).subscribe(
      clientId,
      subscriptionId,
      dataKey,
    );
  },
);

export const unsubscribeSharedDatabaseWorker$ = command(
  ({ get }, clientId: string, subscriptionId: string): void => {
    requireRuntime(get(workerRuntimeState$)).unsubscribe(
      clientId,
      subscriptionId,
    );
  },
);

export const querySharedDatabaseWorker$ = command(
  async (
    { get },
    clientId: string,
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    return await requireRuntime(get(workerRuntimeState$)).query(
      clientId,
      query,
      signal,
    );
  },
);
