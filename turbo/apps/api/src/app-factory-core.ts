import { httpInstrumentationMiddleware } from "@hono/otel";
import * as Sentry from "@sentry/node";
import { serializeError } from "@vm0/core/log-utils";
// oxlint-disable-next-line no-restricted-imports -- app factory owns the Hono instance, confirmed by ethan@vm0.ai
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";

import { corsMiddleware } from "./lib/cors";
import { env } from "./lib/env";
import { flushLogs, logger } from "./lib/log";
import { waitUntil } from "./signals/context/wait-until";
import { honoSignalHandler } from "./signals/context/route";
import type { RouteEntry } from "./signals/route-entry";
import { isAbortError, safeSync } from "./signals/utils";

const L = logger("App");

const WEB_AUTH_PATHS = ["/sign-in", "/sign-up"] as const;
const UNHANDLED_REQUEST_ERROR_TYPE = "unhandled_request_error" as const;
const ERROR_CHAIN_MAX_DEPTH = 32;
const ERROR_SUMMARY_MAX_LENGTH = 240;
const ERROR_SUMMARY_SOURCE_MAX_LENGTH = 4096;

interface UnhandledRequestErrorLogFields {
  readonly type: typeof UNHANDLED_REQUEST_ERROR_TYPE;
  readonly errorSummary: string;
  readonly method: string;
  readonly route?: string;
  readonly errorCode?: string;
  readonly error: Record<string, unknown>;
}

type ErrorWithCode = Error & { readonly code?: unknown };

function shouldCaptureError(error: unknown): boolean {
  return !(error instanceof HTTPException) || error.status >= 500;
}

function captureError(error: unknown): void {
  if (shouldCaptureError(error)) {
    Sentry.captureException(error);
  }
}

function redirectToWeb(context: Context): Response {
  const incoming = new URL(context.req.url);
  const target = new URL(
    `${incoming.pathname}${incoming.search}`,
    env("VM0_WEB_URL"),
  );
  return context.redirect(target.toString());
}

function readErrorValue(read: () => unknown): unknown {
  const result = safeSync(read);
  return "ok" in result ? result.ok : undefined;
}

function readNonErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = readErrorValue(() => {
      return (error as { readonly message?: unknown }).message;
    });
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  const value = readErrorValue(() => {
    return String(error);
  });
  return typeof value === "string" && value.trim() ? value : "unknown error";
}

function errorCause(error: Error): Error | undefined {
  const cause = readErrorValue(() => {
    return error.cause;
  });
  return cause instanceof Error ? cause : undefined;
}

function errorMessage(error: Error): string | undefined {
  const message = readErrorValue(() => {
    return error.message;
  });
  return typeof message === "string" ? message : undefined;
}

function errorName(error: Error): string | undefined {
  const name = readErrorValue(() => {
    return error.name;
  });
  return typeof name === "string" ? name : undefined;
}

function errorCode(error: Error): unknown {
  return readErrorValue(() => {
    return (error as ErrorWithCode).code;
  });
}

function errorChain(error: Error): readonly Error[] {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  while (
    current &&
    !seen.has(current) &&
    chain.length < ERROR_CHAIN_MAX_DEPTH
  ) {
    chain.push(current);
    seen.add(current);
    current = errorCause(current);
  }
  return chain;
}

function sourceErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return readNonErrorMessage(error);
  }
  const chain = errorChain(error);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const current = chain[index];
    const message = current ? errorMessage(current)?.trim() : "";
    if (message) {
      return message;
    }
  }
  return errorName(error) || "unknown error";
}

function truncateSummary(summary: string): string {
  if (summary.length <= ERROR_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, ERROR_SUMMARY_MAX_LENGTH - 3)}...`;
}

function replaceControlCharacters(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code <= 31 || code === 127 ? " " : char;
  }
  return result;
}

function sanitizeErrorSummary(error: unknown): string {
  const source = sourceErrorMessage(error).slice(
    0,
    ERROR_SUMMARY_SOURCE_MAX_LENGTH,
  );
  if (/^response validation failed:/i.test(source)) {
    return "response validation failed";
  }

  const summary = replaceControlCharacters(source)
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[id]",
    )
    .replace(
      /\b(?:user|org)_(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{9,}\b/g,
      "[id]",
    )
    .replace(
      /\bAuthorization\b\s*[:=]\s*["']?(?:Bearer|Basic|Digest|Token)\s+[^,\s"']+/gi,
      "Authorization=[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|id[_\s-]?token|client[_\s-]?secret|authorization|password|secret|token)\b\s*[:=]\s*["']?[^,\s"']+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "[hash]")
    .replace(/\b\d{8,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();

  return truncateSummary(summary || "unknown error");
}

function structuredErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  for (const current of errorChain(error)) {
    const code = errorCode(current);
    if (typeof code === "number" && Number.isFinite(code)) {
      return String(code);
    }
    if (typeof code === "string") {
      const normalized = code.trim();
      if (/^[A-Za-z0-9_.:-]{1,80}$/.test(normalized)) {
        return normalized;
      }
    }
  }
  return undefined;
}

function isTemplateRoute(path: string): boolean {
  return path !== "*" && path !== "/*";
}

function requestRouteTemplate(context: Context): string | undefined {
  const result = safeSync(() => {
    return matchedRoutes(context);
  });
  if (!("ok" in result)) {
    return undefined;
  }
  const routes = result.ok;
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const path = routes[index]?.path;
    if (path && isTemplateRoute(path)) {
      return path;
    }
  }
  return undefined;
}

function unhandledRequestErrorLogFields(
  error: unknown,
  context: Context,
): UnhandledRequestErrorLogFields {
  const route = requestRouteTemplate(context);
  const errorCode = structuredErrorCode(error);
  return {
    type: UNHANDLED_REQUEST_ERROR_TYPE,
    errorSummary: sanitizeErrorSummary(error),
    method: context.req.method,
    ...(route ? { route } : {}),
    ...(errorCode ? { errorCode } : {}),
    error: serializeError(error),
  };
}

function handleError(error: unknown, context: Context): Response {
  if (isAbortError(error)) {
    return context.json({ error: "Internal server error" }, 500);
  }

  captureError(error);

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  const fields = unhandledRequestErrorLogFields(error, context);
  L.error(`Unhandled request error: ${fields.errorSummary}`, fields);
  return context.json({ error: "Internal server error" }, 500);
}

interface CreateAppWithRoutesOptions {
  readonly signal: AbortSignal;
  readonly routes: readonly RouteEntry[];
}

export function createAppWithRoutes({
  routes,
  signal,
}: CreateAppWithRoutesOptions): Hono {
  const app = new Hono();
  app.onError(handleError);

  // OpenTelemetry: each request gets a SERVER span named after its matched
  // route template (e.g. `GET /api/v1/chat-threads/:threadId`). Child spans
  // (db queries, outbound fetches) parent to it via standard context
  // propagation; correlate them to a route by their `trace_id`, not by
  // copying `http.route` onto each child span.
  app.use("*", httpInstrumentationMiddleware({ serviceName: "vm0-api" }));
  // Browser cross-origin requests (e.g. https://app.vm0.ai -> api.vm0.ai). Must
  // run before the route handlers so OPTIONS preflight short-circuits without
  // matching a registered method, and so registered route responses receive
  // Access-Control-Allow-Origin without relying on the legacy web proxy.
  app.use("*", corsMiddleware);

  // Flush buffered Axiom logs after the response is sent so logging doesn't
  // add latency to the user-visible request.
  app.use("*", async (c, next) => {
    await next();
    waitUntil(flushLogs());
  });

  for (const path of WEB_AUTH_PATHS) {
    app.get(path, redirectToWeb);
    app.get(`${path}/*`, redirectToWeb);
  }

  for (const { route, handler } of routes) {
    app.on(route.method, route.path, honoSignalHandler(handler, route, signal));
  }

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
