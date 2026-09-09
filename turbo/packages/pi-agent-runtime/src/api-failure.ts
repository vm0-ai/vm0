const CODEX_USAGE_LIMIT_SNIPPETS = [
  "usage limit",
  "usage_limit",
  "usage-limit",
  "usagelimit",
] as const;

/** Content-free evidence; never infer an HTTP status from provider prose. */
export interface PiApiModelFailureDiagnostic {
  readonly category: "http_error" | "stream_terminated" | "aborted" | "unknown";
  readonly httpStatus?: number;
}

export function projectPiApiModelFailure(
  error: unknown,
  responseStatus?: number,
): PiApiModelFailureDiagnostic {
  const httpStatus =
    responseStatus !== undefined &&
    Number.isInteger(responseStatus) &&
    responseStatus >= 100 &&
    responseStatus <= 599
      ? responseStatus
      : undefined;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  const category =
    httpStatus !== undefined && httpStatus >= 400
      ? "http_error"
      : message === "terminated"
        ? "stream_terminated"
        : error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : "unknown";
  return { category, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

/** Only the request/stream boundary may create this recovery provenance. */
export class PiApiModelRequestError extends Error {
  readonly diagnostic: PiApiModelFailureDiagnostic;
  readonly failureReason: "reconnect_required" | "usage_limit" | undefined;

  constructor(error: unknown, provider: string, responseStatus?: number) {
    super("Pi API model request failed");
    this.name = "PiApiModelRequestError";
    this.diagnostic = projectPiApiModelFailure(error, responseStatus);
    this.failureReason =
      provider === "openai-codex"
        ? classifyPiApiProviderFailure(error)
        : undefined;
  }
}

/** Reduce native provider diagnostics to the only subscription product states. */
export function classifyPiApiProviderFailure(
  error: unknown,
): "reconnect_required" | "usage_limit" | undefined {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  if (!message) {
    return undefined;
  }
  const normalized = message.toLowerCase();
  if (
    normalized.includes("token_refresh_failed") &&
    normalized.includes("codex-oauth-token") &&
    normalized.includes("reconnect_required")
  ) {
    return "reconnect_required";
  }
  return CODEX_USAGE_LIMIT_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet);
  })
    ? "usage_limit"
    : undefined;
}
