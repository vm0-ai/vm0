import "./polyfill.ts";
import { createStore } from "ccstate";
import { createDebugLoggers } from "./lib/debug-loggers.ts";
import { logger } from "./signals/log.ts";
import { detach, Reason } from "./signals/utils.ts";
import { SharedDatabaseMessagePortServer } from "./shared-database/message-port-server.ts";
import { initSharedDatabaseWorkerSentry } from "./shared-database/worker-sentry.ts";
import { bootstrapWorker$ } from "./shared-database/worker-signals.ts";
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
  // abort hook, so this signal stays live for the lifetime of the Worker.
  const workerSignal = AbortSignal.any([]);
  const store = createStore();
  const bootstrap = store.set(bootstrapWorker$, workerSignal);
  if (bootstrap) {
    detach(bootstrap, Reason.Daemon, "shared database Worker bootstrap");
  }
  L.debug("worker.bootstrap");
  workerGlobal.addEventListener("connect", (event): void => {
    L.debug("worker.connect", { portCount: event.ports.length });
    for (const port of event.ports) {
      new SharedDatabaseMessagePortServer(store, port, workerSignal);
    }
  });
}

main();
