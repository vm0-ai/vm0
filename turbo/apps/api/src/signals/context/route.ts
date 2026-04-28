import { type AppRoute, validateResponse } from "@ts-rest/core";
import { createStore, type Command, type Computed } from "ccstate";
import type { Handler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";

import { badRequest } from "../../lib/error";
import { initHono$ } from "./hono";
import { setPathParams$, setQuery$ } from "./request";
import { setRootSignal$ } from "./root";

export type SignalRouteHandler<T> = Computed<T> | Command<T, [AbortSignal]>;

interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value &&
    typeof value.status === "number"
  );
}

function isCommand<T>(
  handler$: SignalRouteHandler<T>,
): handler$ is Command<T, [AbortSignal]> {
  return "write" in handler$;
}

function isContentlessStatus(status: StatusCode): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

interface ZodLikeIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

type ZodLikeResult =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: { readonly issues: ZodLikeIssue[] };
    };

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

const FALLBACK_ISSUE = Object.freeze({
  path: [] as ReadonlyArray<PropertyKey>,
  message: "Bad request",
});

/**
 * Validate `input` against the contract schema and either store the parsed
 * value at `setter` or return the 400 ts-rest response shape. Returns null on
 * success so the caller can branch with `if (error) return error`.
 */
function validateAndStore(
  schema: AppRoute["pathParams"] | AppRoute["query"],
  input: unknown,
  setter: (store: ReturnType<typeof createStore>, value: unknown) => void,
  store: ReturnType<typeof createStore>,
): { status: 400; body: unknown } | null {
  if (!isZodLikeSchema(schema)) {
    setter(store, {});
    return null;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return badRequest(result.error.issues[0] ?? FALLBACK_ISSUE);
  }
  setter(store, result.data);
  return null;
}

export function honoSignalHandler(
  handler$: SignalRouteHandler<unknown>,
  contract: AppRoute,
  signal: AbortSignal,
): Handler {
  return async (context) => {
    const store = createStore();
    store.set(setRootSignal$, signal);
    store.set(initHono$, context);

    // Validate path params and query against the contract schemas before the
    // handler runs. Mirrors the order ts-rest applies on the web side
    // (validation precedes auth) so a malformed request returns 400 without
    // ever touching the auth pipeline or downstream services.
    const pathError = validateAndStore(
      contract.pathParams,
      context.req.param(),
      (s, v) => {
        s.set(setPathParams$, v);
      },
      store,
    );
    if (pathError) {
      return context.json(pathError.body, pathError.status);
    }

    const queryError = validateAndStore(
      contract.query,
      context.req.query(),
      (s, v) => {
        s.set(setQuery$, v);
      },
      store,
    );
    if (queryError) {
      return context.json(queryError.body, queryError.status);
    }

    const data = await (isCommand(handler$)
      ? store.set(handler$, signal)
      : store.get(handler$));
    if (!isRouteResult(data)) {
      throw new Error("Route handler must return a ts-rest response object");
    }

    const response = validateResponse({
      appRoute: contract,
      response: data,
    });
    const status = response.status as StatusCode;
    if (
      isContentlessStatus(status) ||
      !("body" in response) ||
      response.body === undefined
    ) {
      return context.body(null, status);
    }

    return context.json(response.body, status as ContentfulStatusCode);
  };
}
