import type { AppRoute } from "@ts-rest/core";
import { computed, type Computed } from "ccstate";
import type { z } from "zod";

import { badRequest, badRequestMessage } from "../../lib/error";
import { rawPathParams$, rawQuery$, request$, route$ } from "./hono";
import { safeJsonParse } from "../utils";

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
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

const pathParamsResult$ = computed((get): ValidationResult => {
  const schema = get(route$).pathParams;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: {} };
  }
  const result = schema.safeParse(get(rawPathParams$));
  if (!result.success) {
    return { ok: false, issue: result.error?.issues[0] ?? FALLBACK_ISSUE };
  }
  return { ok: true, data: result.data };
});

const queryResult$ = computed((get): ValidationResult => {
  const schema = get(route$).query;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: {} };
  }
  const result = schema.safeParse(get(rawQuery$));
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

export const requestValidation$: Computed<BadRequestResponse | null> = computed(
  (get): BadRequestResponse | null => {
    const path = get(pathParamsResult$);
    if (!path.ok) {
      return badRequest(path.issue);
    }
    const query = get(queryResult$);
    if (!query.ok) {
      return badRequest(query.issue);
    }
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
type RouteWithBody<T> = AppRoute & { readonly body: z.ZodType<T> };

type BodyResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: BadRequestResponse };

export function pathParamsOf<T>(_route: RouteWithPathParams<T>): Computed<T> {
  return validatedPathParams$ as Computed<T>;
}

export function queryOf<T>(_route: RouteWithQuery<T>): Computed<T> {
  return validatedQuery$ as Computed<T>;
}

const bodyResult$ = computed(async (get): Promise<BodyResult<unknown>> => {
  const text = await get(request$).text();

  const parsed = text.length === 0 ? {} : safeJsonParse(text);
  if (parsed === undefined) {
    return {
      ok: false,
      response: badRequestMessage("Invalid JSON in request body"),
    };
  }

  const route = get(route$);
  const schema = "body" in route ? route.body : undefined;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: parsed };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      response: badRequest(result.error?.issues[0] ?? FALLBACK_ISSUE),
    };
  }

  return { ok: true, data: result.data };
});

export function bodyResultOf<T>(
  _route: RouteWithBody<T>,
): Computed<Promise<BodyResult<T>>> {
  return bodyResult$ as Computed<Promise<BodyResult<T>>>;
}
