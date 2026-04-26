import * as Sentry from "@sentry/node";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "./lib/log";
import { honoSignalHandler } from "./signals/context/route";
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

interface CreateAppOptions {
  readonly signal: AbortSignal;
  readonly routes?: ReadonlyArray<RouteDefinition<unknown>>;
}

export function createApp({ routes = ROUTES, signal }: CreateAppOptions): Hono {
  const app = new Hono();
  app.onError(handleError);

  routes.forEach((route: RouteDefinition<unknown>) => {
    app.on(
      route.contract.method,
      route.contract.path,
      honoSignalHandler(route.handler, route.contract, signal),
    );
  });

  return app;
}
