import { computed } from "ccstate";
import { match } from "path-to-regexp";
import { pathname$ } from "./route.ts";
import { ROUTES, type RouteKey } from "./route-paths.ts";

export const activeRoute$ = computed((get): RouteKey | null => {
  const path = get(pathname$);
  for (const [key, pattern] of Object.entries(ROUTES)) {
    if (match(pattern, { decode: decodeURIComponent })(path)) {
      return key as RouteKey;
    }
  }
  return null;
});
