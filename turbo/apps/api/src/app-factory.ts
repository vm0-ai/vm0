import { httpInstrumentationMiddleware } from "@hono/otel";
import { context as otelContext, propagation } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { type Context, type MiddlewareHandler, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
// oxlint-disable-next-line no-restricted-imports -- app-factory needs the matched route resolver before next(); other signals files use the wrappers from signals/context/hono.
import { routePath } from "hono/route";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { request as undiciRequest, type Dispatcher } from "undici";

import { env } from "./lib/env";
import { logger } from "./lib/log";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";

const L = logger("App");

// Hop-by-hop headers (RFC 7230 §6.1) — must not be forwarded across a proxy
// hop. We use undici.request rather than fetch so the upstream bytes (and
// their content-encoding) flow through verbatim; that means content-length
// stays meaningful and is NOT stripped here.
const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  host: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

const PROXY_REQUEST_HEADERS: Readonly<Record<string, true>> = {
  forwarded: true,
  "x-forwarded-host": true,
  "x-forwarded-port": true,
  "x-forwarded-proto": true,
};

function isHopByHop(name: string): boolean {
  return Object.hasOwn(HOP_BY_HOP_HEADERS, name.toLowerCase());
}

function isProxyRequestHeader(name: string): boolean {
  return Object.hasOwn(PROXY_REQUEST_HEADERS, name.toLowerCase());
}

async function proxyToWeb(context: Context, webUrl: string): Promise<Response> {
  const incoming = new URL(context.req.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, webUrl);

  const requestHeaders: Record<string, string> = {};
  for (const [key, value] of context.req.raw.headers) {
    if (!isHopByHop(key) && !isProxyRequestHeader(key)) {
      requestHeaders[key] = value;
    }
  }

  // GET/HEAD must not carry a body. For everything else, adapt the incoming
  // web ReadableStream into a Node Readable for undici.
  const hasBody = context.req.method !== "GET" && context.req.method !== "HEAD";
  // The dom and node:stream/web flavours of ReadableStream are the same
  // runtime object; TS surfaces them as distinct types because tsconfig pulls
  // in lib.dom alongside @types/node, so coerce through unknown.
  const webBody = context.req.raw.body as unknown as NodeReadableStream | null;
  const requestBody =
    hasBody && webBody ? Readable.fromWeb(webBody) : undefined;

  // undici.request — unlike fetch — does not auto-decompress, so compressed
  // upstream bytes flow through verbatim and the original content-encoding
  // header stays accurate.
  const upstream = await undiciRequest(target, {
    method: context.req.method as Dispatcher.HttpMethod,
    headers: requestHeaders,
    body: requestBody,
    signal: context.req.raw.signal,
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || name === "set-cookie" || isHopByHop(name)) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      responseHeaders.append(name, v);
    }
  }
  const setCookie = upstream.headers["set-cookie"];
  if (setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of list) {
      responseHeaders.append("set-cookie", cookie);
    }
  }

  return new Response(Readable.toWeb(upstream.body) as ReadableStream, {
    status: upstream.statusCode,
    headers: responseHeaders,
  });
}

// Stamp the matched route template into OTel baggage so child spans (db
// queries, outbound fetches) can carry `http.route` without reaching back
// into the parent SERVER span. Any code further down the call tree —
// including the pg pool wrapper in `lib/db.ts` — reads it from
// `propagation.getActiveBaggage()`.
//
// `c.req.routePath` reflects the *current* middleware's pattern (here `"*"`)
// until next() returns, but we need the matched route *before* next() so the
// db queries that run inside the handler can pick it up. `routePath(c, -1)`
// from `hono/route` resolves to the last-matched handler's path even when
// called from a middleware position — exactly what @hono/otel uses to name
// its SERVER span.
const httpRouteBaggage: MiddlewareHandler = async (c, next) => {
  const route = routePath(c, -1);
  if (!route || route === "*") {
    return next();
  }
  const current = propagation.getActiveBaggage() ?? propagation.createBaggage();
  const baggage = current.setEntry("http.route", { value: route });
  await otelContext.with(
    propagation.setBaggage(otelContext.active(), baggage),
    () => {
      return next();
    },
  );
};

function shouldCaptureError(error: Error): boolean {
  return !(error instanceof HTTPException) || error.status >= 500;
}

function captureError(error: Error): void {
  if (shouldCaptureError(error)) {
    Sentry.captureException(error);
  }
}

function handleError(error: Error, context: Context): Response {
  if (isAbortError(error)) {
    return context.json({ error: "Internal server error" }, 500);
  }

  captureError(error);

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  L.error("Unhandled request error", error);
  return context.json({ error: "Internal server error" }, 500);
}

interface CreateAppOptions {
  readonly signal: AbortSignal;
  readonly routes?: readonly RouteEntry[];
}

export function createApp({ routes = ROUTES, signal }: CreateAppOptions): Hono {
  const app = new Hono();
  app.onError(handleError);

  // OpenTelemetry: each request gets a SERVER span named after its matched
  // route template (e.g. `GET /api/v1/chat-threads/:threadId`). The baggage
  // middleware then propagates that template down so child spans inherit
  // `http.route` for direct slicing without trace_id joins.
  app.use("*", httpInstrumentationMiddleware({ serviceName: "vm0-api" }));
  app.use("*", httpRouteBaggage);

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  // Routes that have not been ported off the web app yet still hit api.vm0.ai
  // because the domain is now pointed here. Proxy any request that did not
  // match a registered route to VM0_WEB_URL so legacy traffic keeps working
  // until each endpoint is migrated.
  app.notFound((context) => {
    return proxyToWeb(context, env("VM0_WEB_URL"));
  });

  return app;
}
