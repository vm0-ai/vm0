import { type AppRoute, validateResponse } from "@ts-rest/core";
import { createStore, type Command, type Computed } from "ccstate";
import type { Handler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";

import { initHono$, requestValidation$ } from "./hono";
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

export function honoSignalHandler(
  handler$: SignalRouteHandler<unknown>,
  contract: AppRoute,
  signal: AbortSignal,
): Handler {
  return async (context) => {
    const store = createStore();
    store.set(setRootSignal$, signal);
    store.set(initHono$, context, contract);

    // Mirror the order ts-rest applies on the web side: path/query validation
    // precedes auth and downstream services, so a malformed request returns
    // 400 without touching either.
    const validationError = store.get(requestValidation$);
    if (validationError) {
      return context.json(validationError.body, validationError.status);
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
