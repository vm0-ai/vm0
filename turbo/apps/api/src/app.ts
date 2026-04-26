import { Hono } from "hono";

import "./lib/observability";
import { honoComputed } from "./signals/context/route";
import { type RouteDefinition, ROUTES } from "./signals/route";

const app = new Hono();

ROUTES.forEach((route: RouteDefinition<unknown>) => {
  if (route.method === "GET") {
    app.get(route.path, honoComputed(route.handler));
  }
});

export default app;
