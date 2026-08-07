import type { Hono } from "hono";

import { createApp } from "./app-factory";
import { ROUTES } from "./signals/route";

export function createProductionApp(signal?: AbortSignal): Hono {
  return createApp({ signal, routes: ROUTES });
}
