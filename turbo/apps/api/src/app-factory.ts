import * as Sentry from "@sentry/node";
// oxlint-disable-next-line no-restricted-imports -- app-factory owns the Hono instance, confirmed by ethan@vm0.ai
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "./lib/log";
import { honoSignalHandler } from "./signals/context/route";
import { ROUTES, type RouteEntry } from "./signals/route";
import { isAbortError } from "./signals/utils";

const L = logger("App");

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

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  return app;
}
