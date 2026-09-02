import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuthOnAbort,
  mockedClerk,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import type { SharedDatabasePortLike } from "../../shared-database/bridge.ts";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FEATURE_SWITCH_CACHE_KEY } from "../external/feature-switch-state.ts";
import { bridgeConnected$ } from "../shared-database-bridge-state.ts";
import { setupSharedDatabaseBridge$ } from "../shared-database-browser.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

class TestSharedWorkerPort implements SharedDatabasePortLike {
  readonly messages: unknown[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(value: unknown): void {
    this.messages.push(value);
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

async function setupBridge(): Promise<void> {
  const daemon = context.store.set(setupSharedDatabaseBridge$, context.signal);
  context.track(daemon);
  await context.store.get(bridgeConnected$);
}

describe("shared database browser bridge", () => {
  beforeEach(() => {
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "shared-worker-token" },
    );
    mockOrganization({
      activeOrg: { id: "test-org-123", name: "Test Organization" },
      memberships: [{ id: "test-org-123" }],
    });
    clearMockedAuthOnAbort(context.signal);
  });

  it("uses the user and organization as the reusable Worker identity", async () => {
    const { constructorCalls, workers } = installSharedWorkerMock();

    await setupBridge();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options).toStrictEqual({
      name: "okou_test-user-123_test-org-123",
      type: "module",
    });
    const workerUrl = new URL(String(constructorCalls[0]?.scriptURL));
    expect(workerUrl.origin).toBe(window.location.origin);
    expect(workerUrl.search).toBe("?userId=test-user-123&orgId=test-org-123");
    expect(workers[0]!.port.messages).toStrictEqual([{ type: "register-tab" }]);
    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalled();
  });

  it("forwards a captured Preview bypass through the Worker URL", async () => {
    context.mocks.browser.url("https://pr-31037-app.omby.ai/");
    context.mocks.browser.cookie("x-vercel-protection-bypass=preview-secret");
    const { constructorCalls } = installSharedWorkerMock();

    await setupBridge();

    expect(constructorCalls).toHaveLength(1);
    const workerUrl = new URL(String(constructorCalls[0]?.scriptURL));
    expect(workerUrl.searchParams.get("userId")).toBe("test-user-123");
    expect(workerUrl.searchParams.get("orgId")).toBe("test-org-123");
    expect(workerUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
      "preview-secret",
    );
  });

  it("forwards the dev browser JWT through the Worker URL", async () => {
    context.mocks.browser.cookie("__clerk_db_jwt_MGaxFrJr=dev-browser-jwt");
    const { constructorCalls } = installSharedWorkerMock();

    await setupBridge();

    const workerUrl = new URL(String(constructorCalls[0]?.scriptURL));
    expect(workerUrl.searchParams.get("__clerk_db_jwt")).toBe(
      "dev-browser-jwt",
    );
  });

  it("marks the Worker for diagnostics capture when debug is on", async () => {
    globalThis.localStorage.setItem(
      FEATURE_SWITCH_CACHE_KEY,
      JSON.stringify(
        getAllFeatureStates({
          orgId: "test-org-123",
          overrides: { [FeatureSwitchKey.OkouDebug]: true },
        }),
      ),
    );
    const { constructorCalls } = installSharedWorkerMock();

    await setupBridge();

    const workerUrl = new URL(String(constructorCalls[0]?.scriptURL));
    expect(workerUrl.searchParams.get("diagnostics")).toBe("1");
    expect(constructorCalls[0]?.options).toStrictEqual({
      name: "okou_test-user-123_test-org-123_diagnostics",
      type: "module",
    });
  });

  it("does not create a Worker without a settled signed-in session", async () => {
    const { constructorCalls } = installSharedWorkerMock();
    mockUser(null, null);

    const daemon = context.store.set(
      setupSharedDatabaseBridge$,
      context.signal,
    );
    context.track(daemon);
    await daemon;

    expect(constructorCalls).toStrictEqual([]);
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
    const { workers } = installSharedWorkerMock();
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
    vi.spyOn(console, "error").mockImplementation(() => {});

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
  });
});
