import type { AppRoute } from "@ts-rest/core";
import { command, computed, state, type Computed } from "ccstate";
import type { Context } from "hono";
import { RedirectStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

import { badRequest } from "../../lib/error";

const innerHonoContext$ = state<Context>({} as Context);
const innerRoute$ = state<AppRoute | null>(null);

export const initHono$ = command(
  ({ set }, context: Context, route: AppRoute): void => {
    set(innerHonoContext$, context);
    set(innerRoute$, route);
  },
);

// Request Headers
function header(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.req.header(name);
  });
}

export const userAgent$ = header("User-Agent");
export const authorization$ = header("authorization");
export const cookie$ = header("cookie");

// Response Headers
function resHeader(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.res.headers.get(name);
  });
}

export const resUserAgent$ = resHeader("User-Agent");

// Request
export const request$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req;
});

export const requestSignal$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req.raw.signal;
});

// Response
export const setResHeader$ = command(
  ({ get }, name: string, value?: string, options?: { append?: boolean }) => {
    const context = get(innerHonoContext$);
    context.header(name, value, options);
  },
);

export const redirect$ = command(
  ({ get }, url: string | URL, status?: RedirectStatusCode) => {
    const context = get(innerHonoContext$);
    context.redirect(url, status);
  },
);

// Path/query validation derived from the active route's contract. The
// validation runs as a computed off the hono request rather than being pushed
// in via a setter — there is no source of truth other than the request itself,
// and computeds keep the cache invalidation semantics ccstate already gives us.

interface ZodLikeIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

interface ZodLikeResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly issues: readonly ZodLikeIssue[] };
}

interface ZodLikeSchema {
  readonly safeParse: (input: unknown) => ZodLikeResult;
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse: unknown }).safeParse === "function"
  );
}

const FALLBACK_ISSUE: ZodLikeIssue = Object.freeze({
  path: [],
  message: "Bad request",
});

type ValidationResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly issue: ZodLikeIssue };

const route$ = computed((get): AppRoute => {
  const route = get(innerRoute$);
  if (!route) {
    throw new Error("route accessed outside a request scope");
  }
  return route;
});

const pathParamsResult$ = computed((get): ValidationResult => {
  const schema = get(route$).pathParams;
  if (!isZodLikeSchema(schema)) return { ok: true, data: {} };
  const ctx = get(innerHonoContext$);
  const result = schema.safeParse(ctx.req.param());
  if (!result.success) {
    return { ok: false, issue: result.error?.issues[0] ?? FALLBACK_ISSUE };
  }
  return { ok: true, data: result.data };
});

const queryResult$ = computed((get): ValidationResult => {
  const schema = get(route$).query;
  if (!isZodLikeSchema(schema)) return { ok: true, data: {} };
  const ctx = get(innerHonoContext$);
  const result = schema.safeParse(ctx.req.query());
  if (!result.success) {
    return { ok: false, issue: result.error?.issues[0] ?? FALLBACK_ISSUE };
  }
  return { ok: true, data: result.data };
});

interface BadRequestResponse {
  readonly status: 400;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
}

/**
 * Run path and query validation in declared order, returning the first 400
 * response that fails. The hono adapter consumes this to short-circuit
 * malformed requests before invoking the route handler.
 */
export const requestValidation$: Computed<BadRequestResponse | null> = computed(
  (get): BadRequestResponse | null => {
    const path = get(pathParamsResult$);
    if (!path.ok) return badRequest(path.issue);
    const query = get(queryResult$);
    if (!query.ok) return badRequest(query.issue);
    return null;
  },
);

const validatedPathParams$ = computed((get): unknown => {
  const result = get(pathParamsResult$);
  if (!result.ok) {
    throw new Error("pathParamsOf accessed but path validation failed");
  }
  return result.data;
});

const validatedQuery$ = computed((get): unknown => {
  const result = get(queryResult$);
  if (!result.ok) {
    throw new Error("queryOf accessed but query validation failed");
  }
  return result.data;
});

type RouteWithPathParams<T> = AppRoute & { readonly pathParams: z.ZodType<T> };
type RouteWithQuery<T> = AppRoute & { readonly query: z.ZodType<T> };

/**
 * Type-narrowed accessor for the validated path params of `route`. The
 * underlying value is the same `validatedPathParams$` computed for every
 * route — the route argument exists only so TypeScript can infer the shape.
 */
export function pathParamsOf<T>(_route: RouteWithPathParams<T>): Computed<T> {
  return validatedPathParams$ as Computed<T>;
}

export function queryOf<T>(_route: RouteWithQuery<T>): Computed<T> {
  return validatedQuery$ as Computed<T>;
}
