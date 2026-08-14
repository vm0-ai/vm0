import { createStore } from "ccstate";
import { SharedDatabaseMessagePortServer } from "./shared-database/message-port-server.ts";
import { bootstrapSharedDatabaseWorker$ } from "./shared-database/worker-signals.ts";

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerScope {
  addEventListener(
    type: "connect",
    listener: (event: SharedWorkerConnectEvent) => void,
  ): void;
}

const workerScope = globalThis as typeof globalThis & SharedWorkerScope;

function main(): void {
  const store = createStore();
  const rootSignal = AbortSignal.any([]);
  store.set(bootstrapSharedDatabaseWorker$, rootSignal);
  workerScope.addEventListener("connect", (event): void => {
    for (const port of event.ports) {
      new SharedDatabaseMessagePortServer(store, port, rootSignal);
    }
  });
}

main();
