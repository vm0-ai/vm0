import { randomUUID } from "node:crypto";

import type {
  BrowserContext,
  Page,
  Request as PlaywrightRequest,
  Route as PlaywrightRoute,
} from "@playwright/test";

type WorkerScriptMatcher = Parameters<BrowserContext["route"]>[0];

interface SerializedWorkerRequest {
  readonly body: string | null;
  readonly headers: readonly (readonly [string, string])[];
  readonly method: string;
  readonly url: string;
}

interface ContinueResult {
  readonly action: "continue";
}

interface ErrorResult {
  readonly action: "error";
  readonly message: string;
}

interface FulfillResult {
  readonly action: "fulfill";
  readonly body: string | null;
  readonly headers: readonly (readonly [string, string])[];
  readonly status: number;
}

type DispatchResult = ContinueResult | ErrorResult | FulfillResult;

interface ReadyMessage {
  readonly kind: "ready";
}

interface RequestMessage {
  readonly kind: "request";
  readonly request: SerializedWorkerRequest;
  readonly requestId: string;
}

type BridgeMessage = ReadyMessage | RequestMessage;

export interface SharedWorkerFulfillOptions {
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly status?: number;
}

export interface SharedWorkerRequest {
  headerValue(name: string): Promise<string | null>;
  headers(): Readonly<Record<string, string>>;
  method(): string;
  postData(): string | null;
  postDataJSON(): unknown;
  url(): string;
}

export interface SharedWorkerRoute {
  continue(): Promise<void>;
  fulfill(options: SharedWorkerFulfillOptions): Promise<void>;
  request(): SharedWorkerRequest;
}

export type SharedWorkerRouteMatcher =
  | string
  | ((url: URL, request: SharedWorkerRequest) => boolean);

export type SharedWorkerRouteHandler = (
  route: SharedWorkerRoute,
) => Promise<void> | void;

interface RouteEntry {
  readonly handler: SharedWorkerRouteHandler;
  readonly matcher: SharedWorkerRouteMatcher;
}

interface ResponseWaiter {
  readonly matcher: SharedWorkerRouteMatcher;
  readonly reject: (error: Error) => void;
  readonly resolve: (request: SharedWorkerRequest) => void;
  readonly timer: NodeJS.Timeout;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export interface SharedWorkerRoutesOptions {
  readonly apiOrigin: string;
  readonly bridgeOrigin: string;
  readonly context: BrowserContext;
  readonly workerScript: WorkerScriptMatcher;
}

const defaultWaitTimeoutMs = 10_000;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error("Deferred resolver is unavailable");
      }
      resolvePromise(value);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHeaderEntries(
  value: unknown,
): value is readonly (readonly [string, string])[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      return (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      );
    })
  );
}

function isSerializedWorkerRequest(
  value: unknown,
): value is SerializedWorkerRequest {
  return (
    isRecord(value) &&
    (typeof value.body === "string" || value.body === null) &&
    isHeaderEntries(value.headers) &&
    typeof value.method === "string" &&
    typeof value.url === "string"
  );
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  return (
    value.kind === "ready" ||
    (value.kind === "request" &&
      typeof value.requestId === "string" &&
      isSerializedWorkerRequest(value.request))
  );
}

function matches(
  matcher: SharedWorkerRouteMatcher,
  request: SharedWorkerRequest,
): boolean {
  const url = new URL(request.url());
  return typeof matcher === "string"
    ? url.pathname === matcher
    : matcher(url, request);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class WorkerRequest implements SharedWorkerRequest {
  readonly #body: string | null;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #method: string;
  readonly #url: string;

  constructor(request: SerializedWorkerRequest) {
    this.#body = request.body;
    this.#headers = Object.freeze(Object.fromEntries(request.headers));
    this.#method = request.method;
    this.#url = request.url;
  }

  async headerValue(name: string): Promise<string | null> {
    const requestedName = name.toLowerCase();
    const entry = Object.entries(this.#headers).find(([headerName]) => {
      return headerName.toLowerCase() === requestedName;
    });
    return entry?.[1] ?? null;
  }

  headers(): Readonly<Record<string, string>> {
    return this.#headers;
  }

  method(): string {
    return this.#method;
  }

  postData(): string | null {
    return this.#body;
  }

  postDataJSON(): unknown {
    if (this.#body === null) {
      return null;
    }
    const value: unknown = JSON.parse(this.#body);
    return value;
  }

  url(): string {
    return this.#url;
  }
}

class WorkerRoute implements SharedWorkerRoute {
  readonly #request: SharedWorkerRequest;
  #result: DispatchResult | undefined;

  constructor(request: SharedWorkerRequest) {
    this.#request = request;
  }

  async continue(): Promise<void> {
    this.#setResult({ action: "continue" });
  }

  async fulfill(options: SharedWorkerFulfillOptions): Promise<void> {
    if (options.body !== undefined && options.json !== undefined) {
      throw new Error("SharedWorker route cannot fulfill with body and json");
    }
    const headers = new Headers(options.headers);
    if (options.contentType !== undefined) {
      headers.set("content-type", options.contentType);
    }
    let body = options.body ?? null;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
    this.#setResult({
      action: "fulfill",
      body,
      headers: [...headers.entries()],
      status: options.status ?? 200,
    });
  }

  request(): SharedWorkerRequest {
    return this.#request;
  }

  result(): DispatchResult {
    if (!this.#result) {
      throw new Error("SharedWorker route handler did not resolve the request");
    }
    return this.#result;
  }

  #setResult(result: DispatchResult): void {
    if (this.#result) {
      throw new Error("SharedWorker route request was already resolved");
    }
    this.#result = result;
  }
}

/**
 * Routes API fetches without replacing the production SharedWorker topology.
 * The context serves the original worker URL with a fetch seam prepended to
 * its real bundle. A same-origin control page stays alive across app
 * navigations so worker requests cannot lose their response during reload.
 */
export class SharedWorkerRoutes {
  readonly #apiOrigin: string;
  readonly #bindingName = `__vm0SharedWorkerRoute_${randomUUID()}`;
  readonly #bridgeUrl: string;
  readonly #channelName = `vm0-playwright-shared-worker-${randomUUID()}`;
  readonly #context: BrowserContext;
  readonly #failures: Error[] = [];
  readonly #ready = deferred<void>();
  readonly #routes: RouteEntry[] = [];
  readonly #scriptIntercepted = deferred<void>();
  readonly #stateKey = `__vm0SharedWorkerRouteState_${randomUUID()}`;
  readonly #waiters = new Set<ResponseWaiter>();
  readonly #workerScript: WorkerScriptMatcher;
  #bridgePage: Page | undefined;
  #bridgeReady = false;
  #closed = false;

  private constructor(options: SharedWorkerRoutesOptions) {
    this.#apiOrigin = new URL(options.apiOrigin).origin;
    this.#bridgeUrl = new URL(
      `/playwright/shared-worker-routes/${randomUUID()}`,
      options.bridgeOrigin,
    ).href;
    this.#context = options.context;
    this.#workerScript = options.workerScript;
  }

  static async install(
    options: SharedWorkerRoutesOptions,
  ): Promise<SharedWorkerRoutes> {
    const routes = new SharedWorkerRoutes(options);
    await routes.#install();
    return routes;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const cleanupFailures: Error[] = [];

    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error("SharedWorker routes closed before the response"),
      );
    }
    this.#waiters.clear();

    if (this.#bridgeReady && this.#bridgePage && !this.#bridgePage.isClosed()) {
      try {
        await this.#bridgePage.evaluate(async (stateKey) => {
          const value: unknown = Reflect.get(globalThis, stateKey);
          if (!value || typeof value !== "object") {
            throw new Error("SharedWorker route page channel is unavailable");
          }
          const channel: unknown = Reflect.get(value, "channel");
          if (channel instanceof BroadcastChannel) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error("SharedWorker route cleanup timed out"));
              }, 2_000);
              channel.addEventListener(
                "message",
                (event: MessageEvent<unknown>) => {
                  const message = event.data;
                  if (
                    message &&
                    typeof message === "object" &&
                    "kind" in message &&
                    message.kind === "disposed"
                  ) {
                    clearTimeout(timer);
                    resolve();
                  }
                },
              );
              channel.postMessage({ kind: "dispose" });
            });
            channel.close();
          }
          Reflect.deleteProperty(globalThis, stateKey);
        }, this.#stateKey);
      } catch (error: unknown) {
        cleanupFailures.push(
          new Error(
            `Could not dispose SharedWorker routes: ${errorMessage(error)}`,
          ),
        );
      }
    }

    if (this.#bridgePage && !this.#bridgePage.isClosed()) {
      try {
        await this.#bridgePage.close();
      } catch (error: unknown) {
        cleanupFailures.push(
          new Error(
            `Could not close SharedWorker bridge page: ${errorMessage(error)}`,
          ),
        );
      }
    }

    try {
      await this.#context.unroute(
        this.#workerScript,
        this.#interceptWorkerScript,
      );
    } catch (error: unknown) {
      cleanupFailures.push(
        new Error(
          `Could not remove SharedWorker route: ${errorMessage(error)}`,
        ),
      );
    }
    try {
      await this.#context.unroute(this.#bridgeUrl, this.#serveBridgePage);
    } catch (error: unknown) {
      cleanupFailures.push(
        new Error(
          `Could not remove SharedWorker bridge page route: ${errorMessage(error)}`,
        ),
      );
    }

    const failures = [...this.#failures, ...cleanupFailures];
    this.#failures.length = 0;
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "SharedWorker route failures");
    }
  }

  async route(
    matcher: SharedWorkerRouteMatcher,
    handler: SharedWorkerRouteHandler,
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("Cannot register a closed SharedWorker route");
    }
    this.#routes.push({ handler, matcher });
  }

  async waitForReady(timeoutMs = defaultWaitTimeoutMs): Promise<void> {
    await withTimeout(
      Promise.all([this.#scriptIntercepted.promise, this.#ready.promise]).then(
        () => undefined,
      ),
      timeoutMs,
      `SharedWorker route bridge was not ready within ${timeoutMs}ms`,
    );
  }

  waitForResponse(
    matcher: SharedWorkerRouteMatcher,
    timeoutMs = defaultWaitTimeoutMs,
  ): Promise<SharedWorkerRequest> {
    if (this.#closed) {
      return Promise.reject(new Error("SharedWorker routes are closed"));
    }
    return new Promise<SharedWorkerRequest>((resolve, reject) => {
      const waiter: ResponseWaiter = {
        matcher,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new Error(
              `SharedWorker response was not observed within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async #dispatch(message: BridgeMessage): Promise<DispatchResult | null> {
    if (message.kind === "ready") {
      this.#bridgeReady = true;
      this.#ready.resolve(undefined);
      return null;
    }
    const request = new WorkerRequest(message.request);
    if (this.#closed) {
      return { action: "continue" };
    }

    try {
      let entry: RouteEntry | undefined;
      for (let index = this.#routes.length - 1; index >= 0; index -= 1) {
        const candidate = this.#routes[index];
        if (candidate && matches(candidate.matcher, request)) {
          entry = candidate;
          break;
        }
      }
      let result: DispatchResult = { action: "continue" };
      if (entry) {
        const route = new WorkerRoute(request);
        await entry.handler(route);
        result = route.result();
      }
      this.#resolveWaiters(request);
      return result;
    } catch (error: unknown) {
      const failure = new Error(
        `SharedWorker route handler failed for ${request.method()} ${request.url()}: ${errorMessage(error)}`,
        { cause: error },
      );
      this.#failures.push(failure);
      this.#rejectWaiters(request, failure);
      return { action: "error", message: failure.message };
    }
  }

  async #install(): Promise<void> {
    await this.#context.route(this.#bridgeUrl, this.#serveBridgePage);
    this.#bridgePage = await this.#context.newPage();
    await this.#bridgePage.exposeBinding(
      this.#bindingName,
      async (_source, message: unknown) => {
        if (!isBridgeMessage(message)) {
          throw new Error("SharedWorker bridge received an invalid message");
        }
        return await this.#dispatch(message);
      },
    );
    await this.#bridgePage.goto(this.#bridgeUrl);
    await this.#bridgePage.evaluate(
      ({ bindingName, channelName, stateKey }) => {
        const channel = new BroadcastChannel(channelName);
        Reflect.set(globalThis, stateKey, { channel });
        channel.addEventListener("message", (event: MessageEvent<unknown>) => {
          const message = event.data;
          if (
            !message ||
            typeof message !== "object" ||
            !("kind" in message) ||
            (message.kind !== "ready" && message.kind !== "request")
          ) {
            return;
          }
          const binding: unknown = Reflect.get(globalThis, bindingName);
          if (typeof binding !== "function") {
            throw new Error("SharedWorker route binding is unavailable");
          }
          const invoke = binding as (value: unknown) => Promise<unknown>;
          Promise.resolve(invoke(message)).then(
            (result: unknown) => {
              if (message.kind === "request") {
                channel.postMessage({
                  kind: "response",
                  requestId: Reflect.get(message, "requestId"),
                  result,
                });
              }
            },
            (error: unknown) => {
              if (message.kind === "request") {
                channel.postMessage({
                  kind: "response",
                  requestId: Reflect.get(message, "requestId"),
                  result: {
                    action: "error",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                });
              }
            },
          );
        });
      },
      {
        bindingName: this.#bindingName,
        channelName: this.#channelName,
        stateKey: this.#stateKey,
      },
    );
    await this.#context.route(this.#workerScript, this.#interceptWorkerScript);
  }

  readonly #serveBridgePage = async (route: PlaywrightRoute): Promise<void> => {
    await route.fulfill({
      body: "<!doctype html><title>SharedWorker route bridge</title>",
      contentType: "text/html",
    });
  };

  readonly #interceptWorkerScript = async (
    route: PlaywrightRoute,
  ): Promise<void> => {
    const response = await route.fetch();
    if (!response.ok()) {
      throw new Error(
        `SharedWorker script returned ${response.status()}: ${response.url()}`,
      );
    }
    const contentType = response.headers()["content-type"]?.toLowerCase();
    if (
      contentType?.includes("javascript") !== true &&
      contentType?.includes("ecmascript") !== true
    ) {
      throw new Error(
        `SharedWorker script is not JavaScript: ${contentType ?? "missing"}`,
      );
    }
    const body = await response.text();
    await route.fulfill({
      response,
      body: `${this.#workerBridgeSource()}\n${body}`,
    });
    this.#scriptIntercepted.resolve(undefined);
  };

  #rejectWaiters(request: SharedWorkerRequest, error: Error): void {
    for (const waiter of this.#waiters) {
      if (!matches(waiter.matcher, request)) {
        continue;
      }
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.reject(error);
    }
  }

  #resolveWaiters(request: SharedWorkerRequest): void {
    for (const waiter of this.#waiters) {
      if (!matches(waiter.matcher, request)) {
        continue;
      }
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(request);
    }
  }

  #workerBridgeSource(): string {
    const apiOrigin = JSON.stringify(this.#apiOrigin);
    const channelName = JSON.stringify(this.#channelName);
    return `;(() => {
  const apiOrigin = ${apiOrigin};
  const channel = new BroadcastChannel(${channelName});
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const pending = new Map();
  channel.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.kind === "dispose") {
      globalThis.fetch = nativeFetch;
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(new Error("SharedWorker routes were disposed"));
      }
      pending.clear();
      channel.postMessage({ kind: "disposed" });
      channel.close();
      return;
    }
    if (message.kind !== "response") return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    entry.cleanup();
    if (message.result?.action === "error") {
      entry.reject(new Error(message.result.message));
      return;
    }
    entry.resolve(message.result);
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== apiOrigin || !url.pathname.startsWith("/api/")) {
      return await nativeFetch(request);
    }
    const requestId = crypto.randomUUID();
    const body = request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.clone().text();
    const result = await new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(requestId);
        reject(request.signal.reason);
      };
      const cleanup = () => request.signal.removeEventListener("abort", abort);
      if (request.signal.aborted) {
        abort();
        return;
      }
      request.signal.addEventListener("abort", abort, { once: true });
      pending.set(requestId, { cleanup, reject, resolve });
      channel.postMessage({
        kind: "request",
        requestId,
        request: {
          body,
          headers: [...request.headers.entries()],
          method: request.method,
          url: request.url,
        },
      });
    });
    if (result.action === "continue") {
      return await nativeFetch(request);
    }
    return new Response(result.body, {
      headers: result.headers,
      status: result.status,
    });
  };
  channel.postMessage({ kind: "ready" });
})();`;
  }
}

export type SharedWorkerRequestHeaders =
  | Pick<PlaywrightRequest, "headerValue">
  | SharedWorkerRequest;
