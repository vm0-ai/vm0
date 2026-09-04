import { screen } from "@testing-library/react";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { toast } from "@okouai/ui/components/ui/sonner";
import { expect, vi } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import { mockNow } from "../../lib/time.ts";
import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import { logger } from "../log.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import { detach, Reason } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const RELOAD_AT_MS = Date.parse("2030-01-01T00:00:00.000Z");

class TestSharedWorkerPort implements SharedDatabasePortLike {
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(_value: unknown): void {}

  start(): void {}

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

  receive(value: unknown): void {
    this.listener?.(new MessageEvent("message", { data: value }));
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

function setupBridge(): void {
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
}

test("Pass the page identity and Clerk deployment to the shared worker", async () => {
  context.mocks.browser.url("https://app.okou.ai/chats");
  context.mocks.browser.cookie("__clerk_db_jwt=preview-worker-jwt");
  vi.stubGlobal("__vm0ClerkBootstrap", {
    productionPrimaryAppDomain: "app.vm0.ai",
  });
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });

  const workerUrl = new URL(String(constructorCalls[0]!.scriptURL));
  expect(workerUrl.origin).toBe("https://app.okou.ai");
  expect(Object.fromEntries(workerUrl.searchParams)).toStrictEqual({
    __clerk_db_jwt: "preview-worker-jwt",
    clerkPrimaryAppDomain: "app.vm0.ai",
    orgId: "shared-worker-org",
    userId: "shared-worker-user",
  });
  expect(constructorCalls[0]!.options).toStrictEqual({
    name: "okou_shared-worker-user_shared-worker-org",
    type: "module",
  });
});

test("Open the force-upgrade dialog when the worker requires an upgrade", async () => {
  context.mocks.http.get("*/api/indicators", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });
  await setupPage({ context, path: "/" });

  await screen.findByRole("dialog", {
    name: "Update required",
  });
  expect(
    new URL(window.location.href).searchParams.has(
      "okou-shared-database-reload",
    ),
  ).toBeFalsy();
});

test("Reload after an IndexedDB version change makes the worker unavailable", async () => {
  const replace = vi.fn<(url: string) => void>();
  const debug = vi.spyOn(logger("SharedWorkerBridge"), "debug");
  const { workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });
  const currentUrl = new URL("/chat", window.location.href);
  vi.stubGlobal("location", {
    href: currentUrl.toString(),
    hostname: currentUrl.hostname,
    origin: currentUrl.origin,
    replace,
  });

  workers[0]!.port.receive({
    type: "worker-unavailable",
    reason: "indexeddb-version-changed",
  });

  await vi.waitFor(() => {
    expect(replace).toHaveBeenCalledOnce();
  });
  expect(debug).toHaveBeenLastCalledWith("Reloading app", {
    reason: "indexeddb-version-changed",
  });
  const debugCallOrder = debug.mock.invocationCallOrder.at(-1);
  const replaceCallOrder = replace.mock.invocationCallOrder[0];
  if (debugCallOrder === undefined || replaceCallOrder === undefined) {
    throw new Error("Expected debug log before app reload");
  }
  expect(debugCallOrder).toBeLessThan(replaceCallOrder);
});

test("Reload once after the shared-data service fails to load", async () => {
  mockNow(RELOAD_AT_MS, context.signal);
  const replace = vi.fn<(url: string) => void>();
  const debug = vi.spyOn(logger("SharedWorkerBridge"), "debug");
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
  expect(() => {
    workers[0]!.fail();
  }).toThrow(
    "Shared database worker failed to load or its transport became unrecoverable",
  );

  expect(replace).toHaveBeenCalledOnce();
  expect(debug).toHaveBeenLastCalledWith("Reloading app", {
    reason: "worker-load-or-transport-failure",
  });
  const debugCallOrder = debug.mock.invocationCallOrder.at(-1);
  const replaceCallOrder = replace.mock.invocationCallOrder[0];
  if (debugCallOrder === undefined || replaceCallOrder === undefined) {
    throw new Error("Expected debug log before app reload");
  }
  expect(debugCallOrder).toBeLessThan(replaceCallOrder);
  const recoveryUrl = new URL(replace.mock.calls[0]![0]);
  expect(recoveryUrl.searchParams.get("okou-shared-database-reload")).toBe(
    String(RELOAD_AT_MS),
  );
  expect(recoveryUrl.searchParams.get("threadId")).toBe("thread-1");
  expect(recoveryUrl.hash).toBe("#latest");
  expect(constructorCalls).toHaveLength(1);
});

test("Stop reloading when the shared-data service repeatedly fails", async () => {
  mockNow(RELOAD_AT_MS, context.signal);
  const replace = vi.fn<(url: string) => void>();
  const debug = vi.spyOn(logger("SharedWorkerBridge"), "debug");
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
    `/chat?threadId=thread-1&okou-shared-database-reload=${RELOAD_AT_MS - 59_999}#latest`,
    window.location.href,
  );
  vi.stubGlobal("location", {
    href: currentUrl.toString(),
    hostname: currentUrl.hostname,
    origin: currentUrl.origin,
    replace,
  });
  expect(() => {
    workers[0]!.fail();
  }).toThrow(
    "Shared database worker failed to load or its transport became unrecoverable",
  );

  expect(toastError).toHaveBeenCalledOnce();
  expect(debug).not.toHaveBeenCalledWith("Reloading app", {
    reason: "worker-load-or-transport-failure",
  });
  expect(replace).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledOnce();
  const retryUrl = new URL(String(replaceState.mock.calls[0]![2]));
  expect(retryUrl.searchParams.has("okou-shared-database-reload")).toBeFalsy();
  expect(retryUrl.searchParams.get("threadId")).toBe("thread-1");
  expect(retryUrl.hash).toBe("#latest");
  expect(constructorCalls).toHaveLength(1);
});

test("Reload again after the shared-data recovery window has elapsed", async () => {
  mockNow(RELOAD_AT_MS, context.signal);
  const replace = vi.fn<(url: string) => void>();
  const toastError = vi.spyOn(toast, "error");
  const { constructorCalls, workers } = installSharedWorkerMock();
  setupBridge();
  await vi.waitFor(() => {
    expect(workers).toHaveLength(1);
  });
  const currentUrl = new URL(
    `/chat?threadId=thread-1&okou-shared-database-reload=${RELOAD_AT_MS - 60_000}#latest`,
    window.location.href,
  );
  vi.stubGlobal("location", {
    href: currentUrl.toString(),
    hostname: currentUrl.hostname,
    origin: currentUrl.origin,
    replace,
  });
  expect(() => {
    workers[0]!.fail();
  }).toThrow(
    "Shared database worker failed to load or its transport became unrecoverable",
  );

  expect(replace).toHaveBeenCalledOnce();
  const recoveryUrl = new URL(replace.mock.calls[0]![0]);
  expect(recoveryUrl.searchParams.get("okou-shared-database-reload")).toBe(
    String(RELOAD_AT_MS),
  );
  expect(recoveryUrl.searchParams.get("threadId")).toBe("thread-1");
  expect(recoveryUrl.hash).toBe("#latest");
  expect(toastError).not.toHaveBeenCalled();
  expect(constructorCalls).toHaveLength(1);
});
