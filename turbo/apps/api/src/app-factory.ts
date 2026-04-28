import { httpInstrumentationMiddleware } from "@hono/otel";
import { context as otelContext, propagation } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { type Context, type MiddlewareHandler, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { env } from "./lib/env";
import { logger } from "./lib/log";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";

const L = logger("App");

// Hop-by-hop headers must not be forwarded across a proxy hop. fetch() will
// recompute Content-Length and ignore Host, but we strip them defensively.
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

function isHopByHop(name: string): boolean {
  return Object.hasOwn(HOP_BY_HOP_HEADERS, name.toLowerCase());
}

function buildProxyRequest(context: Context, webUrl: string): Request {
  const incoming = new URL(context.req.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, webUrl);

  const headers = new Headers();
  for (const [key, value] of context.req.raw.headers) {
    if (!isHopByHop(key)) {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: context.req.method,
    headers,
    redirect: "manual",
    signal: context.req.raw.signal,
  };

  // GET/HEAD must not have a body. For everything else, stream the incoming
  // body through — `duplex: "half"` is required by undici when sending a
  // ReadableStream body.
  if (context.req.method !== "GET" && context.req.method !== "HEAD") {
    init.body = context.req.raw.body;
    init.duplex = "half";
  }

  return new Request(target, init);
}

async function proxyToWeb(context: Context, webUrl: string): Promise<Response> {
  const upstream = await fetch(buildProxyRequest(context, webUrl));
  // Strip hop-by-hop headers from the upstream response too, so the runtime
  // can set its own Content-Length / Transfer-Encoding for our reply.
  const headers = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!isHopByHop(key)) {
      headers.set(key, value);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// Stamp the matched route template into OTel baggage so child spans (db
// queries, outbound fetches) can carry `http.route` without reaching back
// into the parent SERVER span. Any code further down the call tree —
// including PgInstrumentation's requestHook in instrument.ts — reads it
// from `propagation.getActiveBaggage()`.
const httpRouteBaggage: MiddlewareHandler = async (c, next) => {
  const route = c.req.routePath;
  if (!route) {
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
    const webUrl = env("VM0_WEB_URL");
    if (!webUrl) {
      return context.json({ error: "Not Found" }, 404);
    }
    return proxyToWeb(context, webUrl);
  });

  return app;
}
