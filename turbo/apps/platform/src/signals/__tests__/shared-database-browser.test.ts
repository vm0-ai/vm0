import { describe, expect, it, vi } from "vitest";

import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import { heartbeatSharedDatabase$ } from "../shared-database.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

class TestSharedWorkerPort implements SharedDatabasePortLike {
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(value: unknown): void {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "heartbeat" ||
      !("requestId" in value) ||
      typeof value.requestId !== "string"
    ) {
      return;
    }
    const requestId = value.requestId;
    queueMicrotask(() => {
      this.listener?.(
        new MessageEvent("message", {
          data: { type: "result", requestId, value: null },
        }),
      );
    });
  }

  start(): void {}

  close(): void {
    this.listener = null;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listener = listener;
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }
}

describe("shared database browser bridge", () => {
  it("creates the shared worker with the Okou core service identity", async () => {
    const constructorCalls: {
      readonly options?: string | WorkerOptions;
      readonly scriptURL: string | URL;
    }[] = [];

    class TestSharedWorker {
      readonly port = new TestSharedWorkerPort();

      constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
        constructorCalls.push({ scriptURL, options });
      }

      addEventListener(
        _type: "error",
        _listener: (event: ErrorEvent) => void,
        _options?: AddEventListenerOptions | boolean,
      ): void {}
    }

    vi.stubGlobal("SharedWorker", TestSharedWorker);

    context.store.set(setupSharedDatabaseBridge$, context.signal);
    await context.store.set(
      heartbeatSharedDatabase$,
      {
        identity: {
          userId: "shared-worker-user",
          orgId: "shared-worker-org",
          token: "shared-worker-token",
        },
      },
      context.signal,
    );

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options).toStrictEqual({
      name: "okou core service",
      type: "module",
    });
  });
});
