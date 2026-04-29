import { command, type Command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { safeJsonParse } from "../utils";
import type { SignalRouteHandler } from "./route";
import { request$ } from "./hono";

const log = logger("response-shadow");

const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  "content-length": true,
  host: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

export type ShadowCompareSource = "api" | "web";

interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

interface Difference {
  readonly path: string;
  readonly web: unknown;
  readonly api: unknown;
}

interface ShadowCompareOptions {
  readonly routeName: string;
  readonly handler: SignalRouteHandler<unknown>;
  readonly source: ShadowCompareSource;
  readonly timeoutMs?: number;
}

function isCommand(
  handler$: SignalRouteHandler<unknown>,
): handler$ is Command<unknown, [AbortSignal]> {
  return "write" in handler$;
}

function isHopByHop(name: string): boolean {
  return Object.hasOwn(HOP_BY_HOP_HEADERS, name.toLowerCase());
}

function buildWebRequest(
  request: Request,
  webUrl: string,
  signal: AbortSignal,
): Request {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, webUrl);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!isHopByHop(key)) {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return new Request(target, init);
}

function parseJson(text: string): unknown {
  if (text === "") {
    return null;
  }
  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    return { __invalidJson: text.slice(0, 200) };
  }
  return parsed;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 101 || response.status === 204) {
    return null;
  }
  return parseJson(await response.text());
}

async function fetchWebRouteResult(
  request: Request,
  webUrl: string,
  requestSignal: AbortSignal,
  timeoutMs: number,
): Promise<RouteResult> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([requestSignal, timeoutSignal]);
  const response = await fetch(buildWebRequest(request, webUrl, signal));
  return {
    status: response.status,
    body: await parseResponseBody(response),
  };
}

function routeResult(value: unknown): RouteResult | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value &&
    typeof value.status === "number"
  ) {
    return {
      status: value.status,
      body: value.body,
    };
  }
  return null;
}

function diffJson(
  web: unknown,
  api: unknown,
  path: string,
  out: Difference[],
): void {
  if (Object.is(web, api)) {
    return;
  }

  if (
    web !== null &&
    api !== null &&
    typeof web === "object" &&
    typeof api === "object"
  ) {
    if (Array.isArray(web) || Array.isArray(api)) {
      if (!Array.isArray(web) || !Array.isArray(api)) {
        out.push({ path, web, api });
        return;
      }
      const len = Math.max(web.length, api.length);
      for (let i = 0; i < len; i++) {
        diffJson(web[i], api[i], `${path}[${i}]`, out);
      }
      return;
    }

    const keys = new Set([
      ...Object.keys(web as Record<string, unknown>),
      ...Object.keys(api as Record<string, unknown>),
    ]);
    for (const key of keys) {
      diffJson(
        (web as Record<string, unknown>)[key],
        (api as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
      );
    }
    return;
  }

  if (web !== api) {
    out.push({ path, web, api });
  }
}

function compareRouteResults(
  routeName: string,
  request: Request,
  apiValue: unknown,
  web: RouteResult,
): void {
  const api = routeResult(apiValue);
  const differences: Difference[] = [];

  if (!api) {
    differences.push({
      path: "api",
      web,
      api: { __invalidRouteResult: true },
    });
  } else {
    if (api.status !== web.status) {
      differences.push({ path: "status", web: web.status, api: api.status });
    }
    diffJson(web.body, api.body, "body", differences);
  }

  if (differences.length > 0) {
    const url = new URL(request.url);
    log.warn("response shadow divergence", {
      route: routeName,
      method: request.method,
      path: url.pathname,
      webStatus: web.status,
      apiStatus: api?.status ?? null,
      differences,
    });
  }
}

function logRejected(
  routeName: string,
  source: ShadowCompareSource,
  result: PromiseRejectedResult,
): void {
  const reason = result.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  log.warn("response shadow request failed", {
    route: routeName,
    source,
    error: message,
  });
}

export function shadowCompareRoute({
  routeName,
  handler,
  source,
  timeoutMs = 2000,
}: ShadowCompareOptions): Command<Promise<unknown>, [AbortSignal]> {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
      const request = get(request$).raw;
      const webRequest = request.clone();
      const apiPromise = Promise.resolve(
        isCommand(handler) ? set(handler, signal) : get(handler),
      );

      const webUrl = env("VM0_WEB_URL");
      if (!webUrl) {
        return await apiPromise;
      }

      const webPromise = fetchWebRouteResult(
        webRequest,
        webUrl,
        signal,
        timeoutMs,
      );
      const [apiResult, webResult] = await Promise.allSettled([
        apiPromise,
        webPromise,
      ]);
      signal.throwIfAborted();

      if (
        apiResult.status === "fulfilled" &&
        webResult.status === "fulfilled"
      ) {
        compareRouteResults(
          routeName,
          request,
          apiResult.value,
          webResult.value,
        );
      }
      if (apiResult.status === "rejected") {
        logRejected(routeName, "api", apiResult);
      }
      if (webResult.status === "rejected") {
        logRejected(routeName, "web", webResult);
      }

      const selected = source === "web" ? webResult : apiResult;
      if (selected.status === "fulfilled") {
        return selected.value;
      }
      throw selected.reason;
    },
  );
}
