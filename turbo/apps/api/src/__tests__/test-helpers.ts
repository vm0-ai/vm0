import { Hono } from "hono";
import { afterEach } from "vitest";

import { createApp } from "../app-factory";
import { clearMockedEnv } from "../lib/env";
import { clearAllDetached } from "../signals/utils";

interface TestContext {
  readonly app: Hono;
  readonly signal: AbortSignal;
}

export function testContext(): TestContext {
  let app: Hono | undefined;
  let controller = new AbortController();

  const context: TestContext = {
    get app(): Hono {
      app ??= createApp(context.signal, new Hono());
      return app;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
  };

  afterEach(async () => {
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);
    app = undefined;
    controller = new AbortController();

    await clearAllDetached();
    clearMockedEnv();
  });

  return context;
}
