import { httpInstrumentationMiddleware } from "@hono/otel";
import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { corsMiddleware } from "./lib/cors";
import { env } from "./lib/env";
import { flushLogs, logger } from "./lib/log";
import { waitUntil } from "./signals/context/wait-until";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";

const L = logger("App");

const WEB_AUTH_PATHS = ["/sign-in", "/sign-up"] as const;

function shouldCaptureError(error: Error): boolean {
  return !(error instanceof HTTPException) || error.status >= 500;
}

function captureError(error: Error): void {
  if (shouldCaptureError(error)) {
    Sentry.captureException(error);
  }
}

function redirectToWeb(context: Context): Response {
  const incoming = new URL(context.req.url);
  const target = new URL(
    `${incoming.pathname}${incoming.search}`,
    env("VM0_WEB_URL"),
  );
  return context.redirect(target.toString());
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
  // route template (e.g. `GET /api/v1/chat-threads/:threadId`). Child spans
  // (db queries, outbound fetches) parent to it via standard context
  // propagation; correlate them to a route by their `trace_id`, not by
  // copying `http.route` onto each child span.
  app.use("*", httpInstrumentationMiddleware({ serviceName: "vm0-api" }));
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

  for (const path of WEB_AUTH_PATHS) {
    app.get(path, redirectToWeb);
    app.get(`${path}/*`, redirectToWeb);
  }

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
