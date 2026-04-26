import { Computed } from "ccstate";
import { apiHealth$ } from "./routes/health";
import { apiRoot$ } from "./routes/root";

export type RouteDefinition<T> = {
  path: string;
  method: "GET";
  handler: Computed<T>;
};

export const ROUTES: Readonly<RouteDefinition<unknown>[]> = [
  {
    path: "/",
    method: "GET",
    handler: apiRoot$,
  },
  {
    path: "/health",
    method: "GET",
    handler: apiHealth$,
  },
] as const;
