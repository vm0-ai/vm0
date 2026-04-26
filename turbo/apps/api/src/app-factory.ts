import * as Sentry from "@sentry/node";
import { type Context, type Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "./lib/log";
import { honoComputed } from "./signals/context/route";
import { type RouteDefinition, ROUTES } from "./signals/route";

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
  captureError(error);

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  L.error("Unhandled request error", error);
  return context.json({ error: "Internal server error" }, 500);
}

export function createApp(signal: AbortSignal, app: Hono): Hono {
  app.onError(handleError);

  ROUTES.forEach((route: RouteDefinition<unknown>) => {
    if (route.method === "GET") {
      app.get(route.path, honoComputed(route.handler, signal));
    }
  });

  return app;
}
