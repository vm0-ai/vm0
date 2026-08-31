import type { Browser, CDPSession, Page } from "@playwright/test";

const WORKER_ROUTES_READY_EVENT = "vm0-shared-worker-routes-ready";
const WORKER_ROUTES_READY_STORAGE_KEY = "vm0.sharedWorkerRoutes.ready";

interface PendingChildCommand {
  readonly sessionId: string;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface PausedRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface RouteEntry {
  readonly matches: (url: URL) => boolean;
  readonly handler: SharedWorkerRouteHandler;
  readonly resolveHandled: (request: SharedWorkerRequest) => void;
  handled: boolean;
}

export interface SharedWorkerRequest {
  url(): string;
  method(): string;
  headerValue(name: string): Promise<string | null>;
}

export interface SharedWorkerFulfillOptions {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json: unknown;
}

export interface SharedWorkerRoute {
  request(): SharedWorkerRequest;
  fulfill(options: SharedWorkerFulfillOptions): Promise<void>;
}

export type SharedWorkerRouteHandler = (
  route: SharedWorkerRoute,
) => Promise<void>;

export interface SharedWorkerRouteRegistration {
  readonly handled: Promise<SharedWorkerRequest>;
}

class WorkerRequest implements SharedWorkerRequest {
  constructor(private readonly paused: PausedRequest) {}

  url(): string {
    return this.paused.url;
  }

  method(): string {
    return this.paused.method;
  }

  async headerValue(name: string): Promise<string | null> {
    const normalizedName = name.toLowerCase();
    for (const [headerName, value] of Object.entries(this.paused.headers)) {
      if (headerName.toLowerCase() === normalizedName) {
        return value;
      }
    }
    return null;
  }
}

class WorkerRoute implements SharedWorkerRoute {
  handled = false;

  constructor(
    private readonly workerRequest: SharedWorkerRequest,
    private readonly fulfillRequest: (
      options: SharedWorkerFulfillOptions,
    ) => Promise<void>,
  ) {}

  request(): SharedWorkerRequest {
    return this.workerRequest;
  }

  async fulfill(options: SharedWorkerFulfillOptions): Promise<void> {
    if (this.handled) {
      throw new Error("SharedWorker request was already handled");
    }
    this.handled = true;
    await this.fulfillRequest(options);
  }
}

export class SharedWorkerRoutes {
  private readonly entries: RouteEntry[] = [];
  private readonly pendingCommands = new Map<number, PendingChildCommand>();
  private readonly attachingTargets = new Set<string>();
  private readonly operations = new Set<Promise<void>>();
  private readonly errors: Error[] = [];
  private readonly workerReadyPromise: Promise<void>;
  private readonly resolveWorkerReady: () => void;
  private workerReadyError: Error | undefined;
  private workerReady = false;
  private nextCommandId = 0;
  private closed = false;

  private constructor(
    private readonly session: CDPSession,
    private readonly page: Page,
    private readonly apiPattern: string,
    private readonly browserContextId: string,
  ) {
    let resolveWorkerReady!: () => void;
    this.workerReadyPromise = new Promise<void>((resolve) => {
      resolveWorkerReady = resolve;
    });
    this.resolveWorkerReady = resolveWorkerReady;
    session.on("Target.targetCreated", ({ targetInfo }) => {
      if (
        targetInfo.type === "shared_worker" &&
        targetInfo.browserContextId === this.browserContextId
      ) {
        this.run(this.attach(targetInfo.targetId), (error) => {
          if (!this.workerReady) {
            this.workerReadyError = error;
            this.resolveWorkerReady();
          }
        });
      }
    });
    session.on("Target.detachedFromTarget", ({ sessionId }) => {
      this.rejectPendingCommands(
        sessionId,
        new Error("SharedWorker target detached"),
      );
    });
    session.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      try {
        this.receiveChildMessage(sessionId, message);
      } catch (error) {
        this.errors.push(toError(error));
      }
    });
  }

  static async create(
    browser: Browser,
    page: Page,
    apiOrigin: string,
  ): Promise<SharedWorkerRoutes> {
    // Production sends its heartbeat as soon as the worker connects. Hold
    // page-to-worker messages until Fetch interception is active so the first
    // API request cannot escape before the target session attaches.
    await page.addInitScript(
      ({ readyEvent, readyStorageKey }) => {
        const NativeSharedWorker = globalThis.SharedWorker;
        let released = sessionStorage.getItem(readyStorageKey) === "true";
        const pendingMessages: Array<() => void> = [];
        globalThis.addEventListener(
          readyEvent,
          () => {
            released = true;
            sessionStorage.setItem(readyStorageKey, "true");
            for (const send of pendingMessages.splice(0)) {
              send();
            }
          },
          { once: true },
        );

        const GatedSharedWorker = function (
          scriptURL: string | URL,
          options?: string | WorkerOptions,
        ): SharedWorker {
          const worker =
            typeof options === "string"
              ? new NativeSharedWorker(scriptURL, options)
              : new NativeSharedWorker(scriptURL, options);
          const postMessage = worker.port.postMessage.bind(worker.port);
          worker.port.postMessage = (
            message: unknown,
            transferOrOptions?: Transferable[] | StructuredSerializeOptions,
          ): void => {
            const send = (): void => {
              if (Array.isArray(transferOrOptions)) {
                postMessage(message, transferOrOptions);
              } else {
                postMessage(message, transferOrOptions);
              }
            };
            if (released) {
              send();
            } else {
              pendingMessages.push(send);
            }
          };
          return worker;
        };
        Object.setPrototypeOf(GatedSharedWorker, NativeSharedWorker);
        GatedSharedWorker.prototype = NativeSharedWorker.prototype;
        Object.defineProperty(globalThis, "SharedWorker", {
          configurable: true,
          value: GatedSharedWorker,
          writable: true,
        });
      },
      {
        readyEvent: WORKER_ROUTES_READY_EVENT,
        readyStorageKey: WORKER_ROUTES_READY_STORAGE_KEY,
      },
    );
    const pageSession = await page.context().newCDPSession(page);
    let browserContextId: string;
    try {
      const { targetInfo } = await pageSession.send("Target.getTargetInfo");
      if (!targetInfo.browserContextId) {
        throw new Error("Playwright page has no Chromium browser context id");
      }
      browserContextId = targetInfo.browserContextId;
    } finally {
      await pageSession.detach();
    }
    const session = await browser.newBrowserCDPSession();
    const routes = new SharedWorkerRoutes(
      session,
      page,
      `${new URL(apiOrigin).origin}/api/*`,
      browserContextId,
    );
    try {
      await session.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      await session.detach();
      throw error;
    }
    return routes;
  }

  async waitForWorker(): Promise<void> {
    await this.workerReadyPromise;
    if (this.workerReadyError) {
      throw this.workerReadyError;
    }
    await this.page.evaluate((readyEvent) => {
      globalThis.dispatchEvent(new Event(readyEvent));
    }, WORKER_ROUTES_READY_EVENT);
  }

  route(
    matches: (url: URL) => boolean,
    handler: SharedWorkerRouteHandler,
  ): SharedWorkerRouteRegistration {
    let resolveHandled!: (request: SharedWorkerRequest) => void;
    const handled = new Promise<SharedWorkerRequest>((resolve) => {
      resolveHandled = resolve;
    });
    this.entries.unshift({
      matches,
      handler,
      resolveHandled,
      handled: false,
    });
    return { handled };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.operations);
    await this.session.detach();
    if (this.errors.length === 1) {
      throw this.errors[0];
    }
    if (this.errors.length > 1) {
      throw new AggregateError(
        this.errors,
        "SharedWorker route handling failed",
      );
    }
  }

  private run(
    operation: Promise<void>,
    onError?: (error: Error) => void,
  ): void {
    this.operations.add(operation);
    void operation.then(
      () => {
        this.operations.delete(operation);
      },
      (error: unknown) => {
        this.operations.delete(operation);
        const normalizedError = toError(error);
        this.errors.push(normalizedError);
        onError?.(normalizedError);
      },
    );
  }

  private async attach(targetId: string): Promise<void> {
    if (this.closed || this.attachingTargets.has(targetId)) {
      return;
    }
    this.attachingTargets.add(targetId);
    try {
      const { sessionId } = await this.session.send("Target.attachToTarget", {
        targetId,
        flatten: false,
      });
      if (this.closed) {
        await this.session.send("Target.detachFromTarget", { sessionId });
        return;
      }
      await this.sendChildCommand(sessionId, "Fetch.enable", {
        patterns: [{ urlPattern: this.apiPattern, requestStage: "Request" }],
      });
      this.workerReady = true;
      this.resolveWorkerReady();
    } finally {
      this.attachingTargets.delete(targetId);
    }
  }

  private receiveChildMessage(sessionId: string, message: string): void {
    const value: unknown = JSON.parse(message);
    if (!isRecord(value)) {
      throw new Error("SharedWorker target sent a non-object message");
    }
    if ("id" in value) {
      this.resolveChildCommand(value);
      return;
    }
    if (value.method !== "Fetch.requestPaused") {
      return;
    }
    const paused = parsePausedRequest(value.params);
    this.run(this.handlePausedRequest(sessionId, paused));
  }

  private resolveChildCommand(value: Readonly<Record<string, unknown>>): void {
    if (typeof value.id !== "number") {
      throw new Error("SharedWorker target response has an invalid command id");
    }
    const pending = this.pendingCommands.get(value.id);
    if (!pending) {
      return;
    }
    this.pendingCommands.delete(value.id);
    if ("error" in value) {
      pending.reject(childCommandError(value.error));
      return;
    }
    pending.resolve();
  }

  private async handlePausedRequest(
    sessionId: string,
    paused: PausedRequest,
  ): Promise<void> {
    const url = new URL(paused.url);
    const entry = this.entries.find((candidate) => candidate.matches(url));
    if (!entry) {
      await this.sendChildCommand(sessionId, "Fetch.continueRequest", {
        requestId: paused.requestId,
      });
      return;
    }

    const request = new WorkerRequest(paused);
    const route = new WorkerRoute(request, async (options) => {
      await this.fulfill(sessionId, paused.requestId, options);
    });
    try {
      await entry.handler(route);
      if (!route.handled) {
        throw new Error(
          "SharedWorker route handler did not handle its request",
        );
      }
      if (!entry.handled) {
        entry.handled = true;
        entry.resolveHandled(request);
      }
    } catch (error) {
      if (!route.handled) {
        await this.sendChildCommand(sessionId, "Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "Failed",
        });
      }
      throw error;
    }
  }

  private async fulfill(
    sessionId: string,
    requestId: string,
    options: SharedWorkerFulfillOptions,
  ): Promise<void> {
    const headers = { ...options.headers };
    const body = JSON.stringify(options.json);
    if (body === undefined) {
      throw new Error("SharedWorker JSON response is not serializable");
    }
    if (
      !Object.keys(headers).some(
        (name) => name.toLowerCase() === "content-type",
      )
    ) {
      headers["content-type"] = "application/json";
    }
    await this.sendChildCommand(sessionId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: options.status ?? 200,
      responseHeaders: Object.entries(headers).map(([name, value]) => {
        return { name, value };
      }),
      body: Buffer.from(body).toString("base64"),
    });
  }

  private async sendChildCommand(
    sessionId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const id = ++this.nextCommandId;
    let resolveCommand!: () => void;
    let rejectCommand!: (reason: unknown) => void;
    const command = new Promise<void>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    this.pendingCommands.set(id, {
      sessionId,
      resolve: resolveCommand,
      reject: rejectCommand,
    });
    try {
      await this.session.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    } catch (error) {
      this.pendingCommands.delete(id);
      rejectCommand(error);
    }
    await command;
  }

  private rejectPendingCommands(sessionId: string, reason: Error): void {
    for (const [id, pending] of this.pendingCommands) {
      if (pending.sessionId === sessionId) {
        this.pendingCommands.delete(id);
        pending.reject(reason);
      }
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function parsePausedRequest(value: unknown): PausedRequest {
  if (!isRecord(value) || typeof value.requestId !== "string") {
    throw new Error("SharedWorker target sent an invalid paused request");
  }
  const request = value.request;
  if (
    !isRecord(request) ||
    typeof request.url !== "string" ||
    typeof request.method !== "string" ||
    !isRecord(request.headers)
  ) {
    throw new Error("SharedWorker target sent invalid request details");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(request.headers)) {
    if (typeof headerValue !== "string") {
      throw new Error("SharedWorker target sent an invalid request header");
    }
    headers[name] = headerValue;
  }
  return {
    requestId: value.requestId,
    url: request.url,
    method: request.method,
    headers,
  };
}

function childCommandError(value: unknown): Error {
  if (!isRecord(value) || typeof value.message !== "string") {
    return new Error("SharedWorker target command failed");
  }
  return new Error(value.message);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
