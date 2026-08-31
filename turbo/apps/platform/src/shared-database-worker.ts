import "./polyfill.ts";
import type { Store } from "ccstate";
import { createDebugLoggers } from "./lib/debug-loggers.ts";
import { logger } from "./signals/log.ts";
import { SharedDatabaseMessagePortServer } from "./shared-database/message-port-server.ts";
import { initSharedDatabaseWorkerSentry } from "./shared-database/worker-sentry.ts";
import type { TabId } from "./shared-database/worker-context.ts";
import type { DebugLoggers } from "./types/global-method.ts";

const L = logger("SharedDatabaseWorker");

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerVM0State {
  readonly loggers: DebugLoggers;
}

interface SharedWorkerGlobal {
  _vm0: SharedWorkerVM0State | undefined;
  addEventListener(
    type: "connect",
    listener: (event: SharedWorkerConnectEvent) => void,
  ): void;
}

const workerGlobal = globalThis as typeof globalThis & SharedWorkerGlobal;

function main(): void {
  initSharedDatabaseWorkerSentry();
  workerGlobal._vm0 = {
    get loggers() {
      return createDebugLoggers();
    },
  };

  // SharedWorker termination tears down the whole global without an observable
  // abort hook. Credential Stores still own abortable child lifecycles below.
  const workerSignal = AbortSignal.any([]);
  let nextTabId = 0;
  const credentialStores = new Map<string, Store>();
  const credentialAbortControllers = new Map<string, AbortController>();
  const tabCredentialIds = new Map<TabId, string>();
  const tabHeartbeatAts = new Map<TabId, number>();
  const maps = {
    appVersion: __OKOU_APP_VERSION__,
    allocateTabId: (): TabId => {
      return nextTabId++;
    },
    credentialStores,
    credentialAbortControllers,
    tabCredentialIds,
    tabHeartbeatAts,
  };
  L.debug("worker.bootstrap");
  workerGlobal.addEventListener("connect", (event): void => {
    L.debug("worker.connect", { portCount: event.ports.length });
    for (const port of event.ports) {
      new SharedDatabaseMessagePortServer(port, workerSignal, maps);
    }
  });
}

main();
