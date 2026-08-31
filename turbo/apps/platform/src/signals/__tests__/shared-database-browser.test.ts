import { toast } from "@okouai/ui/components/ui/sonner";
import { describe, expect, it, vi } from "vitest";

import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import type { AuthRecovery } from "../auth-retry.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

class TestSharedWorkerPort implements SharedDatabasePortLike {
  readonly heartbeatTokens: string[] = [];
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
    if ("token" in value && typeof value.token === "string") {
      this.heartbeatTokens.push(value.token);
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

  requireAuthentication(): void {
    queueMicrotask(() => {
      this.listener?.(
        new MessageEvent("message", {
          data: { type: "authentication-required" },
        }),
      );
    });
  }

  close(): void {
    this.listener = null;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.listener = listener;
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        if (this.listener === listener) {
          this.listener = null;
        }
      },
      { once: true },
    );
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

  requireAuthentication(): void {
    this.port.requireAuthentication();
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

function authRecovery(replacementToken = "replacement-token"): AuthRecovery {
  return {
    getToken: () => {
      return Promise.resolve("shared-worker-token");
    },
    forceRefreshToken: () => {
      return Promise.resolve(replacementToken);
    },
  };
}

async function setupBridge(recovery = authRecovery()): Promise<void> {
  await context.store.set(setupSharedDatabaseBridge$, recovery, context.signal);
}

describe("shared database browser bridge", () => {
  it("forces an auth refresh when the worker rejects its credential", async () => {
    const { workers } = installSharedWorkerMock();
    await setupBridge();

    workers[0]!.requireAuthentication();

    await vi.waitFor(() => {
      expect(workers[0]!.port.heartbeatTokens).toStrictEqual([
        "shared-worker-token",
        "replacement-token",
      ]);
    });
  });

  it("creates the shared worker with the Okou core service identity", async () => {
    const { constructorCalls } = installSharedWorkerMock();

    await setupBridge();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options).toStrictEqual({
      name: "okou core service",
      type: "module",
    });
    expect(
      new URL(String(constructorCalls[0]?.scriptURL), window.location.href)
        .origin,
    ).toBe(window.location.origin);
    expect(
      new URL(
        String(constructorCalls[0]?.scriptURL),
        window.location.href,
      ).searchParams.has("okou-app-version"),
    ).toBeFalsy();
  });

  it("reloads once with a recovery marker after a worker load failure", async () => {
    const replace = vi.fn<(url: string) => void>();
    const { constructorCalls, workers } = installSharedWorkerMock();
    await setupBridge();
    const currentUrl = new URL(
      "/chat?threadId=thread-1#latest",
      window.location.href,
    );
    vi.stubGlobal("location", {
      href: currentUrl.toString(),
      origin: currentUrl.origin,
      replace,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    workers[0]!.fail();

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });
    const recoveryUrl = new URL(replace.mock.calls[0]![0]);
    expect(recoveryUrl.searchParams.get("okou-shared-database-reload")).toBe(
      "1",
    );
    expect(recoveryUrl.searchParams.get("threadId")).toBe("thread-1");
    expect(recoveryUrl.hash).toBe("#latest");
    expect(constructorCalls).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("stops the reload loop and removes the recovery marker", async () => {
    const replace = vi.fn<(url: string) => void>();
    const replaceState = vi
      .spyOn(history, "replaceState")
      .mockImplementation(() => {});
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    const { constructorCalls, workers } = installSharedWorkerMock();
    await setupBridge();
    const currentUrl = new URL(
      "/chat?threadId=thread-1&okou-shared-database-reload=1#latest",
      window.location.href,
    );
    vi.stubGlobal("location", {
      href: currentUrl.toString(),
      origin: currentUrl.origin,
      replace,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    workers[0]!.fail();

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledOnce();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledOnce();
    const retryUrl = new URL(String(replaceState.mock.calls[0]![2]));
    expect(
      retryUrl.searchParams.has("okou-shared-database-reload"),
    ).toBeFalsy();
    expect(retryUrl.searchParams.get("threadId")).toBe("thread-1");
    expect(retryUrl.hash).toBe("#latest");
    expect(constructorCalls).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
