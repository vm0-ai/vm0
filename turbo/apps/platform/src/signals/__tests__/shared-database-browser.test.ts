import { toast } from "@okouai/ui/components/ui/sonner";
import { expect, vi } from "vitest";

import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import { detach, Reason } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

class TestSharedWorkerPort implements SharedDatabasePortLike {
  readonly authenticationTokens: string[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(value: unknown): void {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      (value.type !== "heartbeat" && value.type !== "set-token") ||
      !("requestId" in value) ||
      typeof value.requestId !== "string"
    ) {
      return;
    }
    if ("token" in value && typeof value.token === "string") {
      this.authenticationTokens.push(value.token);
    }
    const requestId = value.requestId;
    queueMicrotask(() => {
      this.listener?.(
        new MessageEvent("message", {
          data: {
            type: "result",
            requestId,
            value:
              value.type === "heartbeat"
                ? { clientReconnected: false }
                : undefined,
          },
        }),
      );
    });
  }

  start(): void {}

  requireAuthentication(recoveryId: string): void {
    queueMicrotask(() => {
      this.listener?.(
        new MessageEvent("message", {
          data: { type: "authentication-required", recoveryId },
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

  requireAuthentication(recoveryId: string): void {
    this.port.requireAuthentication(recoveryId);
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

function setupBridge(): ReturnType<typeof context.mocks.clerk> {
  const clerk = context.mocks.clerk();
  clerk.user(
    {
      id: "shared-worker-user",
      fullName: "Shared Worker User",
      email: "shared-worker@example.com",
    },
    { token: "shared-worker-token" },
  );
  clerk.organization({
    activeOrg: { id: "shared-worker-org", name: "Shared Worker Org" },
    memberships: [{ id: "shared-worker-org" }],
  });
  detach(
    context.store.set(setupSharedDatabaseBridge$, context.signal),
    Reason.Daemon,
    "test shared database bridge",
  );
  return clerk;
}

test("Shared chat data recovers worker authentication with a fresh token", async () => {
  const { workers } = installSharedWorkerMock();
  const clerk = setupBridge();
  await vi.waitFor(() => {
    expect(workers[0]?.port.authenticationTokens).toStrictEqual([
      "shared-worker-token",
    ]);
  });
  clerk.user(
    {
      id: "shared-worker-user",
      fullName: "Shared Worker User",
      email: "shared-worker@example.com",
    },
    { token: "replacement-token" },
  );

  workers[0]!.requireAuthentication("recovery-1");

  await vi.waitFor(() => {
    expect(workers[0]!.port.authenticationTokens).toStrictEqual([
      "shared-worker-token",
      "replacement-token",
    ]);
  });
});

test("Reload once after the shared-data service fails to load", async () => {
  const replace = vi.fn<(url: string) => void>();
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });
  const currentUrl = new URL(
    "/chat?threadId=thread-1#latest",
    window.location.href,
  );
  vi.stubGlobal("location", {
    href: currentUrl.toString(),
    hostname: currentUrl.hostname,
    origin: currentUrl.origin,
    replace,
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  workers[0]!.fail();

  await vi.waitFor(() => {
    expect(replace).toHaveBeenCalledOnce();
  });
  const recoveryUrl = new URL(replace.mock.calls[0]![0]);
  expect(recoveryUrl.searchParams.get("okou-shared-database-reload")).toBe("1");
  expect(recoveryUrl.searchParams.get("threadId")).toBe("thread-1");
  expect(recoveryUrl.hash).toBe("#latest");
  expect(constructorCalls).toHaveLength(1);
  expect(consoleError).toHaveBeenCalledOnce();
});

test("Stop reloading when the shared-data service repeatedly fails", async () => {
  const replace = vi.fn<(url: string) => void>();
  const replaceState = vi
    .spyOn(history, "replaceState")
    .mockImplementation(() => {});
  const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });
  const currentUrl = new URL(
    "/chat?threadId=thread-1&okou-shared-database-reload=1#latest",
    window.location.href,
  );
  vi.stubGlobal("location", {
    href: currentUrl.toString(),
    hostname: currentUrl.hostname,
    origin: currentUrl.origin,
    replace,
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  workers[0]!.fail();

  await vi.waitFor(() => {
    expect(toastError).toHaveBeenCalledOnce();
  });
  expect(replace).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledOnce();
  const retryUrl = new URL(String(replaceState.mock.calls[0]![2]));
  expect(retryUrl.searchParams.has("okou-shared-database-reload")).toBeFalsy();
  expect(retryUrl.searchParams.get("threadId")).toBe("thread-1");
  expect(retryUrl.hash).toBe("#latest");
  expect(constructorCalls).toHaveLength(1);
  expect(consoleError).toHaveBeenCalledOnce();
});
