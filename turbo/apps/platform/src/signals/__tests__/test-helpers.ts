import { createStore, type Store } from "ccstate";
import { afterEach } from "vitest";
import { logger, resetLoggerForTest } from "../log";
import { resetLocalStorageForTest$ } from "../external/local-storage";
import { resetAllMockHandlers } from "../../mocks/handlers";
import { createTestMocks, type TestMocks } from "./test-mocks.ts";

const L = logger("Test");

export interface TestContext {
  readonly mocks: TestMocks;
  readonly signal: AbortSignal;
  readonly store: Store;
}

export function testContext(): TestContext {
  let store: Store | null = null;
  let mocks: TestMocks | null = null;
  let controller = new AbortController();

  const context: TestContext = {
    get mocks(): TestMocks {
      mocks ??= createTestMocks(() => {
        return context.signal;
      });
      return mocks;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    get store(): Store {
      if (!store) {
        L.debug("create store");
        store = createStore();
        context.signal.addEventListener("abort", () => {
          store?.set(resetLocalStorageForTest$);
          resetLoggerForTest();
          resetAllMockHandlers();

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
