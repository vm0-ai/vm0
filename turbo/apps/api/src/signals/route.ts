import { Computed } from "ccstate";
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
] as const;
