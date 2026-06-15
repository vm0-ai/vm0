import { httpInstrumentationMiddleware } from "@hono/otel";
import { context as otelContext, propagation } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
// oxlint-disable-next-line no-restricted-imports -- app-factory needs the matched route resolver before next(); other signals files use the wrappers from signals/context/hono.
import { routePath } from "hono/route";

import { corsMiddleware } from "./lib/cors";
import { flushLogs, logger } from "./lib/log";
import { waitUntil } from "./signals/context/wait-until";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";

const L = logger("App");

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
  // Browser cross-origin requests (e.g. https://app.vm0.ai → api.vm0.ai). Must
  // run before the route handlers so OPTIONS preflight short-circuits without
  // matching a registered method, and so registered route responses receive
  // Access-Control-Allow-Origin without relying on the legacy web proxy.
  app.use("*", corsMiddleware);

  // Flush buffered Axiom logs after the response is sent so logging doesn't
  // add latency to the user-visible request.
  app.use("*", async (c, next) => {
    await next();
    waitUntil(flushLogs());
  });

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
