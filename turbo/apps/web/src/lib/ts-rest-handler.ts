/**
 * Unified ts-rest handler configuration with automatic post-response log flushing.
 *
 * Wraps createNextHandler to schedule telemetry flushes after the response
 * has been returned, without adding telemetry latency to the API response.
 *
 * Usage:
 *   import { createHandler, tsr } from "@/lib/ts-rest-handler";
 *   const router = tsr.router(contract, { ... });
 *   const handler = createHandler(contract, router);
 *   export { handler as GET, handler as POST };
 *
 * ## Sentry capture rules
 *
 * Errors are filtered at three independent points: this handler's
 * `createSafeErrorHandler`, Next.js's `instrumentation.onRequestError`
 * (for non-ts-rest routes), and the browser SDK's `beforeSend` hook
 * in `instrumentation-client.ts`. What reaches Sentry:
 *
 * | Origin                                    | Status / Class          | Reaches Sentry?       |
 * |-------------------------------------------|-------------------------|-----------------------|
 * | ts-rest, `createSafeErrorHandler`         | 4xx `ApiError`          | No (warn-log)         |
 * | ts-rest, `createSafeErrorHandler`         | 4xx zod validation      | No (warn-log)         |
 * | ts-rest, `createSafeErrorHandler`         | 400 malformed JSON body | No (warn-log)         |
 * | ts-rest, `createSafeErrorHandler`         | unknown 5xx throw       | Yes (†)               |
 * | ts-rest, `createSilentErrorHandler`       | any                     | No (‡)                |
 * | non-ts-rest route (any thrown error)      | any                     | Yes (onRequestError)  |
 * | Client, 4xx fetch/XHR response            | —                       | No (beforeSend drops) |
 * | Client, 5xx response or JS error          | —                       | Yes                   |
 *
 * † Captured with `mechanism.type = "ts-rest-handler"` and
 *   `tags.route = <routeName>`. 5xx `ApiError` instances (uncommon —
 *   current factories top out at 422) are `log.error`'d but NOT
 *   Sentry-captured; capture fires only for the final "unknown throw"
 *   branch of `makeErrorHandler`.
 *
 * ‡ `createSilentErrorHandler` is used only by `/api/zero/report-error`
 *   so the client-error sink does not feed its own failures back into
 *   Sentry as fresh issues.
 */
import "server-only";
import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import type { TsRestRequest } from "@ts-rest/serverless";
import type { AppRoute, AppRouter } from "@ts-rest/core";
import * as Sentry from "@sentry/nextjs";
import { after } from "next/server";
import { flushLogs, logger } from "./shared/logger";
import { ingestRequestLog, flushAxiom } from "./shared/axiom";
import { isApiError } from "@vm0/api-services/errors";

// Re-export tsr and TsRestResponse for convenience
export { tsr, TsRestResponse };

/**
 * Type alias for ts-rest router implementation.
 * This is the return type of `tsr.router(contract, { ... })`.
 */
type TsRestRouter<T extends AppRouter> = ReturnType<typeof tsr.router<T>>;

/**
 * Walk a ts-rest contract and build a `${method}:${path}` → operation-name
 * map. Nested sub-routers get dot-joined keys (e.g. `billing.checkout`).
 * Used to attach an operation suffix to `routeName` in the default error
 * handler so multi-op handlers produce distinct log labels.
 */
function buildOperationMap(contract: AppRouter): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: AppRouter, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      if ("method" in value && "path" in value) {
        const route = value as AppRoute;
        const op = prefix ? `${prefix}.${key}` : key;
        map.set(`${route.method}:${route.path}`, op);
      } else {
        walk(value as AppRouter, prefix ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(contract, "");
  return map;
}

/**
 * Create a safe error handler that sanitizes error messages for API responses.
 *
 * - Zod validation errors (bodyError/queryError) are safe to return as-is
 * - All other errors are logged server-side with full details but return
 *   a generic message to the client (CWE-209, OWASP ASVS V7.4.1)
 *
 * @param routeName - Route identifier for server-side logging
 */
export function createSafeErrorHandler(
  routeName: string,
): (err: unknown) => TsRestResponse | void {
  return makeErrorHandler(routeName, { reportToSentry: true });
}

/**
 * Like {@link createSafeErrorHandler} but does NOT forward unhandled errors
 * to Sentry. Use for routes whose *own* purpose is to report errors (e.g.
 * the client-error sink endpoint) — otherwise a failing report can echo
 * back into Sentry as a fresh issue, creating a self-referential loop.
 * Server logs still record the failure at error level.
 */
export function createSilentErrorHandler(
  routeName: string,
): (err: unknown) => TsRestResponse | void {
  return makeErrorHandler(routeName, { reportToSentry: false });
}

function makeErrorHandler(
  routeName: string,
  options: { reportToSentry: boolean },
): (err: unknown) => TsRestResponse | void {
  const log = logger(`api:${routeName}`);

  return function safeErrorHandler(err: unknown): TsRestResponse | void {
    // Zod/standard-schema validation errors are safe to return (field names + validation messages)
    if (err && typeof err === "object") {
      // ts-rest validation errors have bodyError, queryError, and/or pathParamsError
      const hasValidationFields =
        "bodyError" in err || "queryError" in err || "pathParamsError" in err;

      if (hasValidationFields) {
        const validationError = err as {
          bodyError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
          queryError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
          pathParamsError?: {
            issues: Array<{ path: string[]; message: string }>;
          } | null;
        };

        const source =
          validationError.pathParamsError ??
          validationError.bodyError ??
          validationError.queryError;
        const sourceLabel = validationError.pathParamsError
          ? "pathParams"
          : validationError.bodyError
            ? "body"
            : "query";
        if (source) {
          const issue = source.issues[0];
          if (issue) {
            const path = issue.path.join(".");
            const message = path ? `${path}: ${issue.message}` : issue.message;
            log.warn(`validation error (${sourceLabel}): ${message}`);
            return TsRestResponse.fromJson(
              { error: { message, code: "BAD_REQUEST" } },
              { status: 400 },
            );
          }
        }
      }
    }

    // Application errors with explicit status codes (BadRequest, NotFound, etc.)
    if (isApiError(err)) {
      if (err.statusCode >= 500) {
        log.error(`${routeName} error:`, err);
      } else {
        log.warn(`${routeName} client error:`, err);
      }
      return TsRestResponse.fromJson(
        { error: { message: err.message, code: err.code } },
        { status: err.statusCode },
      );
    }

    // Malformed JSON in the request body thrown from the ts-rest
    // `evaluateContent` middleware (via undici `parseJSONFromBytes`).
    // This is a client bug, not ours — classify as 400 so it doesn't
    // page oncall or burn a Sentry event.
    if (err instanceof SyntaxError && err.message.includes("JSON")) {
      log.warn(`${routeName} invalid json body: ${err.message}`);
      return TsRestResponse.fromJson(
        {
          error: {
            message: "Invalid JSON in request body",
            code: "BAD_REQUEST",
          },
        },
        { status: 400 },
      );
    }

    // Non-validation errors: log full details server-side, return generic message
    log.error(`${routeName} error:`, err);
    if (options.reportToSentry) {
      // Report to Sentry. Without this, ts-rest-handled 5xx never reaches
      // Sentry because the error is caught here and a 500 JSON is returned,
      // so Next.js's onRequestError instrumentation hook never fires.
      Sentry.captureException(err, {
        mechanism: { type: "ts-rest-handler", handled: true },
        captureContext: { tags: { route: routeName } },
      });
    }
    return TsRestResponse.fromJson(
      {
        error: {
          message: "An internal error occurred. Please try again later.",
          code: "INTERNAL_ERROR",
        },
      },
      { status: 500 },
    );
  };
}

/**
 * Options for createHandler.
 *
 * Route naming convention: `<area>.<resource>[.<sub>][.<op|byId>]`, mirroring
 * the URL path with parameters collapsed to the operation name. Examples:
 *   /api/agent/runs/[id]          → "agent.runs.byId"
 *   /api/zero/chat-threads        → "zero.chat-threads"
 *   /api/webhooks/agent/complete  → "webhooks.agent.complete"
 */
interface CreateHandlerOptions {
  /** Stable route identifier used for structured logs and error tags. */
  routeName: string;
  /** Custom error handler for validation and other errors */
  errorHandler?: (err: unknown) => TsRestResponse | void;
}

// WeakMap to store request start times
const requestStartTimes = new WeakMap<TsRestRequest, number>();

/**
 * Create a Next.js route handler with automatic post-response log flushing.
 *
 * This wrapper records request logs synchronously, then asks Next.js to flush
 * telemetry after the response is returned. That keeps observability reliable
 * without making user-facing API latency wait on Axiom or Sentry delivery.
 *
 * @param contract - The ts-rest contract definition
 * @param router - The ts-rest router implementation (from tsr.router)
 * @param options - Must include `routeName`; may override `errorHandler`.
 */
export function createHandler<T extends AppRouter>(
  contract: T,
  router: TsRestRouter<T>,
  options: CreateHandlerOptions,
) {
  // Pre-build per-operation error handlers for multi-op contracts so each
  // operation surfaces its own label (e.g. `zero.chat-threads.create` vs
  // `zero.chat-threads.list`). Single-op contracts keep `options.routeName`
  // directly — the name already uniquely identifies the operation.
  const opMap = options.errorHandler ? null : buildOperationMap(contract);
  const perOpHandlers =
    opMap && opMap.size > 1
      ? new Map(
          [...new Set(opMap.values())].map((op) => {
            return [
              op,
              createSafeErrorHandler(`${options.routeName}.${op}`),
            ] as const;
          }),
        )
      : null;
  const defaultHandler = createSafeErrorHandler(options.routeName);

  const resolvedErrorHandler = (
    err: unknown,
    req: TsRestRequest,
  ): TsRestResponse | void => {
    if (options.errorHandler) {
      const result = options.errorHandler(err);
      if (result) return result;
      // Custom handler declined this error (returned undefined) — delegate to
      // the default chain so ApiError → correct status, raw errors → log +
      // Sentry. ts-rest's own dispatcher uses the same truthy-check semantic.
    }
    if (perOpHandlers && opMap) {
      const op = opMap.get(`${req.method}:${req.route}`);
      const h = op ? perOpHandlers.get(op) : undefined;
      if (h) return h(err);
    }
    return defaultHandler(err);
  };

  return createNextHandler(contract, router, {
    errorHandler: resolvedErrorHandler,
    handlerType: "app-router",
    // jsonQuery is intentionally disabled: JSON.parse() misinterprets hex strings
    // like "846e3519" as scientific notation, corrupting version query params (#2666)
    jsonQuery: false,
    requestMiddleware: [
      (request) => {
        // Record request start time
        requestStartTimes.set(request, Date.now());
      },
    ],
    responseHandlers: [
      (response, request) => {
        // Record request log (nginx-style)
        const startTime = requestStartTimes.get(request);
        if (startTime !== undefined) {
          const url = new URL(request.url);
          ingestRequestLog({
            remote_addr:
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
              "unknown",
            user_agent: request.headers.get("user-agent") || "",
            method: request.method,
            path_template: request.route,
            host: url.host,
            status: response.status,
            body_bytes_sent: 0, // Not available from TsRestResponse
            request_time_ms: Date.now() - startTime,
          });
          requestStartTimes.delete(request);
        }

        // Callback form preserves the Next.js request context for work
        // scheduled by the flush implementations.
        after(() => {
          return Promise.all([
            flushLogs(),
            flushAxiom(),
            Sentry.flush(2000).catch(() => {
              return false;
            }),
          ]).then(() => {
            return undefined;
          });
        });
      },
    ],
  });
}
