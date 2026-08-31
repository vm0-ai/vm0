import { randomUUID } from "node:crypto";
import type { Browser, CDPSession, Page } from "@playwright/test";

import {
  installPageBridge,
  workerBridgeSource,
  WORKER_ROUTES_READY_EVENT,
} from "./shared-worker-route-bridge";

interface PendingChildCommand {
  readonly sessionId: string;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface PausedRequest {
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

interface ContinueResponse {
  readonly action: "continue";
}

interface FailResponse {
  readonly action: "fail";
}

interface FulfillResponse {
  readonly action: "fulfill";
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type RouteResponse = ContinueResponse | FailResponse | FulfillResponse;

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
  response: FulfillResponse | undefined;

  constructor(private readonly workerRequest: SharedWorkerRequest) {}

  request(): SharedWorkerRequest {
    return this.workerRequest;
  }

  async fulfill(options: SharedWorkerFulfillOptions): Promise<void> {
    if (this.response) {
      throw new Error("SharedWorker request was already handled");
    }
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
    this.response = {
      action: "fulfill",
      status: options.status ?? 200,
      headers,
      body,
    };
  }
}

export class SharedWorkerRoutes {
  private readonly entries: RouteEntry[] = [];
  private readonly pendingCommands = new Map<number, PendingChildCommand>();
  private readonly candidateTargets = new Map<string, boolean>();
  private readonly attachingTargets = new Set<string>();
  private readonly operations = new Set<Promise<void>>();
  private readonly errors: Error[] = [];
  private readonly workerReadyPromise: Promise<void>;
  private readonly resolveWorkerReady: () => void;
  private readonly closeError = new Error("SharedWorker routes closed");
  private workerReadyError: Error | undefined;
  private workerReady = false;
  private nextCommandId = 0;
  private closed = false;

  private constructor(
    private readonly session: CDPSession,
    private readonly page: Page,
    private readonly apiOrigin: string,
    private readonly browserContextId: string,
    private readonly channelName: string,
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
        this.candidateTargets.set(targetInfo.targetId, targetInfo.attached);
      }
    });
    session.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const sawAttached = this.candidateTargets.get(targetInfo.targetId);
      if (sawAttached === undefined) {
        return;
      }
      if (targetInfo.attached) {
        this.candidateTargets.set(targetInfo.targetId, true);
        return;
      }
      if (sawAttached) {
        this.candidateTargets.delete(targetInfo.targetId);
        this.run(this.attach(targetInfo.targetId), (error) => {
          if (!this.closed && !this.workerReady) {
            this.workerReadyError = error;
            this.resolveWorkerReady();
          }
        });
      }
    });
    session.on("Target.targetDestroyed", ({ targetId }) => {
      this.candidateTargets.delete(targetId);
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
    const channelName = `vm0-shared-worker-routes-${randomUUID()}`;
    const routesBindingName = `__vm0RouteSharedWorkerRequest_${randomUUID().replaceAll("-", "")}`;
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
      new URL(apiOrigin).origin,
      browserContextId,
      channelName,
    );
    try {
      await page.exposeBinding(
        routesBindingName,
        async (_source, value: unknown): Promise<RouteResponse> => {
          return await routes.handleRequest(value);
        },
      );
      await installPageBridge(page, channelName, routesBindingName);
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
    this.rejectAllPendingCommands(this.closeError);
    await this.session.detach();
    await Promise.allSettled(this.operations);
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
        if (!this.closed) {
          this.errors.push(normalizedError);
        }
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
        return;
      }
      await this.sendChildCommand(
        sessionId,
        "Runtime.runIfWaitingForDebugger",
        {},
      );
      await this.sendChildCommand(sessionId, "Runtime.evaluate", {
        awaitPromise: true,
        expression: workerBridgeSource(this.channelName, this.apiOrigin),
        returnByValue: true,
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
    if (!("id" in value)) {
      return;
    }
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

  private async handleRequest(value: unknown): Promise<RouteResponse> {
    if (this.closed) {
      return { action: "continue" };
    }
    const paused = parsePausedRequest(value);
    const entry = this.entries.find((candidate) => {
      return candidate.matches(new URL(paused.url));
    });
    if (!entry) {
      return { action: "continue" };
    }
    const request = new WorkerRequest(paused);
    const route = new WorkerRoute(request);
    try {
      await entry.handler(route);
      if (!route.response) {
        throw new Error(
          "SharedWorker route handler did not handle its request",
        );
      }
      if (!entry.handled) {
        entry.handled = true;
        entry.resolveHandled(request);
      }
      return route.response;
    } catch (error) {
      this.errors.push(toError(error));
      return { action: "fail" };
    }
  }

  private async sendChildCommand(
    sessionId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.closed) {
      throw this.closeError;
    }
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

  private rejectAllPendingCommands(reason: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(reason);
    }
    this.pendingCommands.clear();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function parsePausedRequest(value: unknown): PausedRequest {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.method !== "string" ||
    !isRecord(value.headers)
  ) {
    throw new Error("SharedWorker route received invalid request details");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== "string") {
      throw new Error("SharedWorker route received an invalid request header");
    }
    headers[name] = headerValue;
  }
  return {
    url: value.url,
    method: value.method,
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
