import type { Hono } from "hono";

import { createAppWithRoutes } from "./app-factory-core";
import type { RouteEntry } from "./signals/route-entry";

interface CreateAppOptions {
  readonly signal: AbortSignal;
  readonly routes: readonly RouteEntry[];
}

export function createApp({ routes, signal }: CreateAppOptions): Hono {
  return createAppWithRoutes({ signal, routes });
}
