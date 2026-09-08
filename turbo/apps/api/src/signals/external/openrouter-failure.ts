import { singleton } from "../../lib/singleton";

/** Origin evidence only; annotating preserves the error identity for shared callers. */
export type OpenRouterFailureReason =
  | "rate_limited"
  | "upstream_timeout"
  | "network"
  | "provider_unavailable"
  | "invalid_request"
  | "auth"
  | "invalid_output"
  | "unknown";

const failureReasons = singleton(() => {
  return new WeakMap<object, OpenRouterFailureReason>();
});

export function openRouterFailureReason(
  error: unknown,
): OpenRouterFailureReason {
  return typeof error === "object" && error !== null
    ? (failureReasons().get(error) ?? "unknown")
    : "unknown";
}

export function recordOpenRouterFailure(
  error: unknown,
  reason: OpenRouterFailureReason,
): void {
  if (typeof error === "object" && error !== null) {
    failureReasons().set(error, reason);
  }
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined;
}

export function recordOpenRouterRequestFailure(
  error: Error,
  status: number,
  origin: "http" | "completion",
  value: unknown,
): void {
  const detail = property(value, "error") ?? value;
  const code = property(error, "errorCode") ?? property(detail, "code");
  const errorType = property(property(detail, "metadata"), "error_type");
  const httpStatus = origin === "http" ? status : undefined;
  let reason: OpenRouterFailureReason = "unknown";
  if (
    [401, 403].some((candidate) => {
      return candidate === httpStatus || candidate === code;
    })
  ) {
    reason = "auth";
  } else if (
    [
      400,
      402,
      404,
      413,
      422,
      "invalid_request_error",
      "invalid_argument",
      "invalid_parameter",
      "unsupported_parameter",
      "unsupported_value",
      "INVALID_ARGUMENT",
    ].some((candidate) => {
      return candidate === httpStatus || candidate === code;
    }) ||
    errorType === "invalid_request_error"
  ) {
    reason = "invalid_request";
  } else if (
    code === "rate_limit_exceeded" ||
    code === 429 ||
    errorType === "rate_limit_exceeded" ||
    httpStatus === 429
  ) {
    reason = "rate_limited";
  } else if (httpStatus === 408 || httpStatus === 504) {
    reason = "upstream_timeout";
  } else if (httpStatus === 502 || httpStatus === 503) {
    reason = "provider_unavailable";
  }
  recordOpenRouterFailure(error, reason);
}

/** Call only at fetch/body I/O, never around feature code or output interpretation. */
export function recordOpenRouterTransportFailure(error: unknown): void {
  const code =
    property(property(error, "cause"), "code") ?? property(error, "code");
  if (
    typeof code === "string" &&
    [
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ETIMEDOUT",
    ].includes(code)
  ) {
    recordOpenRouterFailure(error, "upstream_timeout");
  } else if (
    (typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "ENOTFOUND",
        "ENETUNREACH",
        "UND_ERR_SOCKET",
      ].includes(code)) ||
    (code === undefined &&
      error instanceof TypeError &&
      (error.message === "fetch failed" || error.message === "Failed to fetch"))
  ) {
    recordOpenRouterFailure(error, "network");
  }
}
