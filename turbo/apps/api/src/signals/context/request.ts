import type { AppRoute } from "@ts-rest/core";
import { command, computed, state, type Computed } from "ccstate";
import type { z } from "zod";

const innerPathParams$ = state<unknown>(undefined);
const innerQuery$ = state<unknown>(undefined);

/**
 * Validated path params from the route's contract. Populated by
 * `honoSignalHandler` before the route handler runs, so handlers can read
 * typed values without re-parsing. Internal — handlers should use the
 * `pathParamsOf(route)` typed accessor below.
 */
const pathParams$ = computed((get): unknown => {
  const value = get(innerPathParams$);
  if (value === undefined) {
    throw new Error("pathParams$ accessed outside a request scope");
  }
  return value;
});

const query$ = computed((get): unknown => {
  const value = get(innerQuery$);
  if (value === undefined) {
    throw new Error("query$ accessed outside a request scope");
  }
  return value;
});

export const setPathParams$ = command(({ set }, value: unknown): void => {
  set(innerPathParams$, value);
});

export const setQuery$ = command(({ set }, value: unknown): void => {
  set(innerQuery$, value);
});

type RouteWithPathParams<T> = AppRoute & { readonly pathParams: z.ZodType<T> };
type RouteWithQuery<T> = AppRoute & { readonly query: z.ZodType<T> };

/**
 * Type-narrowed accessor for the route's validated path params. The underlying
 * value is the same `pathParams$` atom — this just narrows `unknown` to the
 * contract's inferred shape.
 */
export function pathParamsOf<T>(_route: RouteWithPathParams<T>): Computed<T> {
  return pathParams$ as Computed<T>;
}

export function queryOf<T>(_route: RouteWithQuery<T>): Computed<T> {
  return query$ as Computed<T>;
}
