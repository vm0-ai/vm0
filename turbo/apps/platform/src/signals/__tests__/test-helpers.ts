import { createStore, type Store } from "ccstate";
import { afterEach } from "vitest";
import { logger, Level } from "../log";

const L = logger("Test");

export interface TestFixtureConfig {
  store: Store;
  signal: AbortSignal;
  debugLoggers?: string[];
}

export interface TestContext {
  readonly signal: AbortSignal;
  readonly store: Store;
}

export function enableDebugLogger(...loggers: string[]): Record<string, Level> {
  const config: Record<string, Level> = {};
  for (const logger of loggers) {
    config[logger] = Level.Debug;
  }
  return config;
}

export function testContext(): TestContext {
  let store: Store | null = null;
  let controller = new AbortController();

  const context: TestContext = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get store(): Store {
      if (!store) {
        L.debug("create store");
        store = createStore();
        context.signal.addEventListener("abort", () => {
          store = null;
        });
      }
      return store;
    },
  };

  afterEach(() => {
    L.debug("cleanup context");
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);
    controller = new AbortController();
  });

  return context;
}
