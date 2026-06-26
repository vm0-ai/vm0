import { describe, expect, it, vi, type Mock } from "vitest";
import serviceWorkerSource from "../../public/sw.js?raw";

interface FetchListenerEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

type FetchListener = (event: FetchListenerEvent) => void;
type TestFetch = (request: Request, init?: RequestInit) => Promise<Response>;

interface TestClients {
  readonly claim: Mock<() => Promise<void>>;
  readonly matchAll: Mock<() => Promise<readonly unknown[]>>;
  readonly openWindow: Mock<() => Promise<null>>;
}

interface TestServiceWorkerGlobal {
  readonly clients: TestClients;
  readonly location: URL;
  readonly registration: {
    readonly showNotification: Mock<() => Promise<void>>;
  };
  readonly skipWaiting: Mock<() => void>;
  addEventListener(type: string, listener: unknown): void;
}

interface TestCacheStorage {
  readonly delete: Mock<() => Promise<boolean>>;
  readonly keys: Mock<() => Promise<readonly string[]>>;
  readonly match: Mock<(request: Request) => Promise<Response | undefined>>;
  readonly open: Mock<() => Promise<TestCache>>;
}

type ServiceWorkerScriptArgs = readonly [
  eventConstructor: typeof Event,
  promiseConstructor: PromiseConstructor,
  requestConstructor: typeof Request,
  responseConstructor: typeof Response,
  urlConstructor: typeof URL,
  cacheStorage: TestCacheStorage,
  clients: TestClients,
  consoleObject: typeof console,
  fetchFn: TestFetch,
  selfObject: TestServiceWorkerGlobal,
];
type ServiceWorkerScript = (...args: ServiceWorkerScriptArgs) => void;

interface TestRuntime {
  readonly cache: TestCache;
  readonly fetchListener: FetchListener;
  readonly fetchMock: Mock<TestFetch>;
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

function runServiceWorkerScript({
  cacheStorage,
  fetchMock,
  self,
}: {
  readonly cacheStorage: TestCacheStorage;
  readonly fetchMock: TestFetch;
  readonly self: TestServiceWorkerGlobal;
}): void {
  const executeServiceWorker = new Function(
    "Event",
    "Promise",
    "Request",
    "Response",
    "URL",
    "caches",
    "clients",
    "console",
    "fetch",
    "self",
    `${serviceWorkerSource}\n//# sourceURL=platform-service-worker-test.js`,
  ) as ServiceWorkerScript;

  executeServiceWorker(
    Event,
    Promise,
    Request,
    Response,
    URL,
    cacheStorage,
    self.clients,
    console,
    fetchMock,
    self,
  );
}

function createServiceWorkerRuntime(): TestRuntime {
  const cache = new TestCache();
  const listeners = new Map<string, unknown[]>();
  const fetchMock = vi.fn<TestFetch>(
    (_request: Request, _init?: RequestInit): Promise<Response> => {
      return Promise.resolve(
        new Response("ok", {
          headers: { "content-type": "application/javascript" },
        }),
      );
    },
  );
  const self: TestServiceWorkerGlobal = {
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
  const cacheStorage: TestCacheStorage = {
    delete: vi.fn((): Promise<boolean> => Promise.resolve(true)),
    keys: vi.fn((): Promise<readonly string[]> => Promise.resolve([])),
    match: vi.fn(
      (_request: Request): Promise<Response | undefined> =>
        Promise.resolve(undefined),
    ),
    open: vi.fn((): Promise<TestCache> => Promise.resolve(cache)),
  };
  runServiceWorkerScript({
    cacheStorage,
    fetchMock,
    self,
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

const REVALIDATED_STATIC_ASSET_URLS = [
  "https://app.test/firewall-metadata/v1/gmail.generated.js",
] as const;

describe("platform service worker", () => {
  it.each(REVALIDATED_STATIC_ASSET_URLS)(
    "revalidates stable generated firewall asset requests and caches successful responses: %s",
    async (url) => {
      const runtime = createServiceWorkerRuntime();
      const request = new Request(url);
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
        throw new Error("generated firewall asset response was not cached");
      }
      await expect(cached.text()).resolves.toBe("export const ok = true;");
    },
  );

  it.each(REVALIDATED_STATIC_ASSET_URLS)(
    "uses cached stable generated firewall assets only when revalidation cannot reach the network: %s",
    async (url) => {
      const runtime = createServiceWorkerRuntime();
      const request = new Request(url);
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
    },
  );

  it.each(REVALIDATED_STATIC_ASSET_URLS)(
    "uses the network response when stable generated firewall asset cache storage cannot be updated: %s",
    async (url) => {
      const runtime = createServiceWorkerRuntime();
      const request = new Request(url);
      runtime.cache.entries.set(
        request.url,
        new Response("stale", {
          headers: { "content-type": "application/javascript" },
        }),
      );
      runtime.fetchMock.mockResolvedValueOnce(
        new Response("fresh", {
          headers: { "content-type": "application/javascript" },
        }),
      );
      runtime.cache.put.mockRejectedValueOnce(new Error("quota exceeded"));

      const response = await dispatchFetch(runtime, request);

      await expect(response.text()).resolves.toBe("fresh");
    },
  );

  it.each(REVALIDATED_STATIC_ASSET_URLS)(
    "does not hide reachable 404 responses behind cached stable generated firewall assets: %s",
    async (url) => {
      const runtime = createServiceWorkerRuntime();
      const request = new Request(url);
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
    },
  );
});
