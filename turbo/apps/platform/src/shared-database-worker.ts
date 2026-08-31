import "./polyfill.ts";
import { createStore } from "ccstate";
import { createDebugLoggers } from "./lib/debug-loggers.ts";
import { logger } from "./signals/log.ts";
import { SharedDatabaseMessagePortServer } from "./shared-database/message-port-server.ts";
import { initSharedDatabaseWorkerSentry } from "./shared-database/worker-sentry.ts";
import { bootstrapSharedDatabaseWorker$ } from "./shared-database/worker-signals.ts";
import type { DebugLoggers } from "./types/global-method.ts";

const L = logger("SharedDatabaseWorker");

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerVM0Global {
  readonly loggers: DebugLoggers;
}

interface SharedWorkerScope {
  _vm0: SharedWorkerVM0Global | undefined;
  addEventListener(
    type: "connect",
    listener: (event: SharedWorkerConnectEvent) => void,
  ): void;
}

const workerScope = globalThis as typeof globalThis & SharedWorkerScope;

function main(): void {
  initSharedDatabaseWorkerSentry();
  workerScope._vm0 = {
    get loggers() {
      return createDebugLoggers();
    },
  };

  const store = createStore();
  const rootSignal = AbortSignal.any([]);
  store.set(bootstrapSharedDatabaseWorker$, __OKOU_APP_VERSION__, rootSignal);
  L.debug("worker.bootstrap");
  workerScope.addEventListener("connect", (event): void => {
    L.debug("worker.connect", { portCount: event.ports.length });
    for (const port of event.ports) {
      new SharedDatabaseMessagePortServer(store, port, rootSignal);
    }
  });
}

main();
