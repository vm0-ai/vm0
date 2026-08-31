import type { Page } from "@playwright/test";

export const WORKER_ROUTES_READY_EVENT = "vm0-shared-worker-routes-ready";

const WORKER_ROUTES_READY_STORAGE_KEY = "vm0.sharedWorkerRoutes.ready";
const ROUTE_REQUEST_TYPE = "vm0-shared-worker-route-request";
const ROUTE_RESPONSE_TYPE = "vm0-shared-worker-route-response";

export async function installPageBridge(
  page: Page,
  channelName: string,
  bindingName: string,
): Promise<void> {
  // Keep the injected code browser-native. Passing a transpiled callback can
  // leak tsx's __name helper into the page, where that helper does not exist.
  await page.addInitScript({
    content: pageBridgeSource(channelName, bindingName),
  });
}

function pageBridgeSource(channelName: string, bindingName: string): string {
  return `(() => {
    if (window.frameElement !== null) return;
    const channel = new BroadcastChannel(${JSON.stringify(channelName)});
    channel.addEventListener("message", (event) => {
      const value = event.data;
      if (
        typeof value !== "object" ||
        value === null ||
        value.type !== ${JSON.stringify(ROUTE_REQUEST_TYPE)} ||
        typeof value.requestId !== "string" ||
        !("request" in value)
      ) return;
      const binding = globalThis[${JSON.stringify(bindingName)}];
      if (typeof binding !== "function") {
        throw new Error("SharedWorker route binding is unavailable");
      }
      void Promise.resolve(binding(value.request)).then((response) => {
        channel.postMessage({
          type: ${JSON.stringify(ROUTE_RESPONSE_TYPE)},
          requestId: value.requestId,
          response,
        });
      });
    });

    const NativeSharedWorker = globalThis.SharedWorker;
    let released = sessionStorage.getItem(${JSON.stringify(WORKER_ROUTES_READY_STORAGE_KEY)}) === "true";
    const pendingMessages = [];
    globalThis.addEventListener(
      ${JSON.stringify(WORKER_ROUTES_READY_EVENT)},
      () => {
        released = true;
        sessionStorage.setItem(${JSON.stringify(WORKER_ROUTES_READY_STORAGE_KEY)}, "true");
        for (const send of pendingMessages.splice(0)) send();
      },
      { once: true },
    );
    const GatedSharedWorker = function (scriptURL, options) {
      const worker = new NativeSharedWorker(scriptURL, options);
      const port = worker.port;
      const postMessage = port.postMessage.bind(port);
      const gatedPort = {
        addEventListener: port.addEventListener.bind(port),
        close: port.close.bind(port),
        postMessage: (message, transferOrOptions) => {
          const send = () => {
            if (transferOrOptions === undefined) postMessage(message);
            else postMessage(message, transferOrOptions);
          };
          if (released) send();
          else pendingMessages.push(send);
        },
        removeEventListener: port.removeEventListener.bind(port),
        start: port.start.bind(port),
      };
      return new Proxy(worker, {
        get: (target, property) => {
          if (property === "port") return gatedPort;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set: (target, property, value) => {
          return Reflect.set(target, property, value, target);
        },
      });
    };
    Object.setPrototypeOf(GatedSharedWorker, NativeSharedWorker);
    GatedSharedWorker.prototype = NativeSharedWorker.prototype;
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: GatedSharedWorker,
      writable: true,
    });
  })();`;
}

export function workerBridgeSource(
  channelName: string,
  apiOrigin: string,
): string {
  return `(() => new Promise((resolveBridge, rejectBridge) => {
    const installBridge = () => {
      const channel = new BroadcastChannel(${JSON.stringify(channelName)});
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const pending = new Map();
      channel.addEventListener("message", (event) => {
        const value = event.data;
        if (value?.type !== ${JSON.stringify(ROUTE_RESPONSE_TYPE)}) return;
        const resolve = pending.get(value.requestId);
        if (!resolve) return;
        pending.delete(value.requestId);
        resolve(value.response);
      });
      const routedFetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== ${JSON.stringify(apiOrigin)} || !url.pathname.startsWith("/api/")) {
          return await nativeFetch(request);
        }
        const requestId = crypto.randomUUID();
        const response = await new Promise((resolve) => {
          pending.set(requestId, resolve);
          channel.postMessage({
            type: ${JSON.stringify(ROUTE_REQUEST_TYPE)},
            requestId,
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(request.headers.entries()),
            },
          });
        });
        if (response.action === "continue") return await nativeFetch(request);
        if (response.action === "fail") throw new TypeError("Failed to fetch");
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      };
      globalThis.fetch = routedFetch;
      resolveBridge();
    };
    if (globalThis._vm0 !== undefined) {
      installBridge();
      return;
    }
    // The production worker assigns _vm0 after Sentry initialization and
    // before accepting connections. Observe that assignment without polling,
    // then restore the ordinary writable data property expected by the app.
    Object.defineProperty(globalThis, "_vm0", {
      configurable: true,
      get: () => undefined,
      set: (value) => {
        Object.defineProperty(globalThis, "_vm0", {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
        try {
          installBridge();
        } catch (error) {
          rejectBridge(error);
        }
      },
    });
  }))()`;
}
