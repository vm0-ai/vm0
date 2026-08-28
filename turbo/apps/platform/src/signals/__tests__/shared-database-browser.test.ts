import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import type {
  SharedDatabaseHeartbeat,
  SharedDatabasePortLike,
} from "../../shared-database/bridge.ts";
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
          data: {
            type: "result",
            requestId,
            value: { clientReconnected: false },
          },
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

interface SharedWorkerConstructorCall {
  readonly options?: string | WorkerOptions;
  readonly scriptURL: string | URL;
}

class TestSharedWorker {
  readonly port = new TestSharedWorkerPort();
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private readonly scriptURL: string;

  constructor(
    scriptURL: string | URL,
    options: string | WorkerOptions | undefined,
    constructorCalls: SharedWorkerConstructorCall[],
  ) {
    this.scriptURL = String(scriptURL);
    constructorCalls.push({ scriptURL, options });
  }

  addEventListener(
    _type: "error",
    listener: (event: ErrorEvent) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.errorListener = listener;
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        this.errorListener = null;
      },
      { once: true },
    );
  }

  fail(): void {
    this.errorListener?.(
      new ErrorEvent("error", {
        error: new Error("SharedWorker module script failed to load"),
        filename: this.scriptURL,
        message: "SharedWorker module script failed to load",
      }),
    );
  }
}

function installSharedWorkerMock(): {
  readonly constructorCalls: SharedWorkerConstructorCall[];
  readonly workers: TestSharedWorker[];
} {
  const constructorCalls: SharedWorkerConstructorCall[] = [];
  const workers: TestSharedWorker[] = [];
  class SharedWorkerMock extends TestSharedWorker {
    constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
      super(scriptURL, options, constructorCalls);
      workers.push(this);
    }
  }
  vi.stubGlobal("SharedWorker", SharedWorkerMock);
  return { constructorCalls, workers };
}

function sharedDatabaseHeartbeat(): SharedDatabaseHeartbeat {
  return {
    identity: {
      userId: "shared-worker-user",
      orgId: "shared-worker-org",
      token: "shared-worker-token",
    },
  };
}

async function setupBridge(): Promise<void> {
  context.store.set(setupSharedDatabaseBridge$, context.signal);
  await context.store.set(
    heartbeatSharedDatabase$,
    sharedDatabaseHeartbeat(),
    context.signal,
  );
}

describe("shared database browser bridge", () => {
  it("creates the shared worker with the Okou core service identity", async () => {
    const { constructorCalls } = installSharedWorkerMock();

    await setupBridge();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options).toStrictEqual({
      name: "okou core service",
      type: "module",
    });
  });

  it("recreates the shared worker when the module asset is still available", async () => {
    const { constructorCalls, workers } = installSharedWorkerMock();
    await setupBridge();
    const workerUrl = String(constructorCalls[0]!.scriptURL);
    context.mocks.http.get(workerUrl, () => {
      return new HttpResponse("export {};", {
        headers: { "content-type": "application/javascript" },
      });
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    workers[0]!.fail();
    await context.store.set(
      heartbeatSharedDatabase$,
      sharedDatabaseHeartbeat(),
      context.signal,
    );

    expect(constructorCalls).toHaveLength(2);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "missing",
      response: () => {
        return new HttpResponse("Not found", { status: 404 });
      },
    },
    {
      label: "replaced by HTML",
      response: () => {
        return new HttpResponse("<!doctype html>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
  ])("reloads when the worker asset is $label", async ({ response }) => {
    const reload = vi.fn<() => void>();
    const { constructorCalls, workers } = installSharedWorkerMock();
    await setupBridge();
    vi.stubGlobal("location", {
      href: window.location.href,
      origin: window.location.origin,
      reload,
    });
    const workerUrl = String(constructorCalls[0]!.scriptURL);
    context.mocks.http.get(workerUrl, response);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    workers[0]!.fail();
    const heartbeat = context.store.set(
      heartbeatSharedDatabase$,
      sharedDatabaseHeartbeat(),
      context.signal,
    );
    context.track(heartbeat);

    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
    });
    expect(constructorCalls).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("waits for connectivity before recreating the shared worker", async () => {
    const { constructorCalls, workers } = installSharedWorkerMock();
    await setupBridge();
    const workerUrl = String(constructorCalls[0]!.scriptURL);
    let probeRequests = 0;
    context.mocks.http.get(workerUrl, () => {
      probeRequests += 1;
      return HttpResponse.error();
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    workers[0]!.fail();
    const heartbeat = context.store.set(
      heartbeatSharedDatabase$,
      sharedDatabaseHeartbeat(),
      context.signal,
    );
    await vi.waitFor(() => {
      expect(probeRequests).toBe(1);
    });
    expect(constructorCalls).toHaveLength(1);

    await Promise.resolve();
    window.dispatchEvent(new Event("online"));
    await heartbeat;

    expect(constructorCalls).toHaveLength(2);
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
