import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface FetchListenerEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

type FetchListener = (event: FetchListenerEvent) => void;

interface TestRuntime {
  readonly cache: TestCache;
  readonly fetchListener: FetchListener;
  readonly fetchMock: ReturnType<typeof vi.fn>;
}

class TestCache {
  readonly entries = new Map<string, Response>();

  readonly delete = vi.fn((request: Request): Promise<boolean> => {
    return Promise.resolve(this.entries.delete(request.url));
  });

  readonly match = vi.fn((request: Request): Promise<Response | undefined> => {
    return Promise.resolve(this.entries.get(request.url));
  });

  readonly put = vi.fn(
    (request: Request, response: Response): Promise<void> => {
      this.entries.set(request.url, response);
      return Promise.resolve();
    },
  );
}

function isFetchListener(value: unknown): value is FetchListener {
  return typeof value === "function";
}

function createServiceWorkerRuntime(): TestRuntime {
  const cache = new TestCache();
  const listeners = new Map<string, unknown[]>();
  const fetchMock = vi.fn(
    (_request: Request, _init?: RequestInit): Promise<Response> => {
      return Promise.resolve(
        new Response("ok", {
          headers: { "content-type": "application/javascript" },
        }),
      );
    },
  );
  const self = {
    clients: {
      claim: vi.fn((): Promise<void> => Promise.resolve()),
      matchAll: vi.fn((): Promise<readonly unknown[]> => Promise.resolve([])),
      openWindow: vi.fn((): Promise<null> => Promise.resolve(null)),
    },
    location: new URL("https://app.test"),
    registration: {
      showNotification: vi.fn((): Promise<void> => Promise.resolve()),
    },
    skipWaiting: vi.fn(),
    addEventListener(type: string, listener: unknown): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const context = vm.createContext({
    Event,
    Promise,
    Request,
    Response,
    URL,
    caches: {
      delete: vi.fn((): Promise<boolean> => Promise.resolve(true)),
      keys: vi.fn((): Promise<readonly string[]> => Promise.resolve([])),
      open: vi.fn((): Promise<TestCache> => Promise.resolve(cache)),
    },
    clients: self.clients,
    console,
    fetch: fetchMock,
    self,
  });
  const swPath = path.resolve(import.meta.dirname, "../../public/sw.js");
  vm.runInContext(fs.readFileSync(swPath, "utf8"), context, {
    filename: swPath,
  });

  const fetchListener = listeners.get("fetch")?.find(isFetchListener);
  if (!fetchListener) {
    throw new Error("service worker fetch listener not registered");
  }

  return { cache, fetchListener, fetchMock };
}

async function dispatchFetch(
  runtime: TestRuntime,
  request: Request,
): Promise<Response> {
  let responsePromise: Promise<Response> | null = null;
  runtime.fetchListener({
    request,
    respondWith(response): void {
      responsePromise = Promise.resolve(response);
    },
  });

  if (!responsePromise) {
    throw new Error("service worker did not handle request");
  }
  return await responsePromise;
}

describe("platform service worker", () => {
  it("revalidates firewall metadata requests and caches successful responses", async () => {
    const runtime = createServiceWorkerRuntime();
    const request = new Request(
      "https://app.test/firewall-metadata/v1/gmail.generated.js",
    );
    runtime.fetchMock.mockResolvedValueOnce(
      new Response("export const ok = true;", {
        headers: { "content-type": "application/javascript" },
      }),
    );

    const response = await dispatchFetch(runtime, request);

    expect(runtime.fetchMock).toHaveBeenCalledWith(request, {
      cache: "no-cache",
    });
    expect(response.ok).toBeTruthy();
    expect(runtime.cache.put).toHaveBeenCalledTimes(1);
    const cached = runtime.cache.entries.get(request.url);
    if (!cached) {
      throw new Error("metadata response was not cached");
    }
    await expect(cached.text()).resolves.toBe("export const ok = true;");
  });

  it("uses cached firewall metadata only when revalidation cannot reach the network", async () => {
    const runtime = createServiceWorkerRuntime();
    const request = new Request(
      "https://app.test/firewall-metadata/v1/gmail.generated.js",
    );
    runtime.cache.entries.set(
      request.url,
      new Response("cached", {
        headers: { "content-type": "application/javascript" },
      }),
    );
    runtime.fetchMock.mockRejectedValueOnce(new TypeError("offline"));

    const response = await dispatchFetch(runtime, request);

    expect(runtime.fetchMock).toHaveBeenCalledWith(request, {
      cache: "no-cache",
    });
    await expect(response.text()).resolves.toBe("cached");
  });

  it("does not hide reachable 404 responses behind cached firewall metadata", async () => {
    const runtime = createServiceWorkerRuntime();
    const request = new Request(
      "https://app.test/firewall-metadata/v1/gmail.generated.js",
    );
    runtime.cache.entries.set(
      request.url,
      new Response("cached", {
        headers: { "content-type": "application/javascript" },
      }),
    );
    runtime.fetchMock.mockResolvedValueOnce(
      new Response("missing", {
        headers: { "content-type": "text/plain" },
        status: 404,
      }),
    );

    const response = await dispatchFetch(runtime, request);

    expect(response.status).toBe(404);
    expect(runtime.cache.put).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("missing");
  });
});
