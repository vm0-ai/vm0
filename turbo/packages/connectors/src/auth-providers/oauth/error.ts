const MAX_BODY_LENGTH = 500;

export type OAuthTokenOperation =
  | "authorize"
  | "exchange"
  | "refresh"
  | "revoke"
  | "start"
  | "poll"
  | "userinfo"
  | "server list"
  | "device authorization start"
  | "long-lived token exchange"
  | string;

export type OAuthFailureClass =
  | "reconnect_required"
  | "upstream_auth_unavailable"
  | "provider_auth_rejected"
  | "provider_response_invalid";

export interface OAuthProviderError extends Error {
  readonly name: "OAuthProviderError";
  readonly provider: string;
  readonly operation: OAuthTokenOperation;
  readonly failureClass: OAuthFailureClass;
  readonly retryable: boolean;
  readonly upstreamStatus?: number;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
  readonly refreshErrorCode?: string;
}

interface CreateOAuthProviderErrorArgs {
  readonly provider: string;
  readonly operation: OAuthTokenOperation;
  readonly message: string;
  readonly failureClass: OAuthFailureClass;
  readonly upstreamStatus?: number;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
  readonly refreshErrorCode?: string;
}

function isReconnectRequiredOAuthError(
  oauthError: string | undefined,
): boolean {
  return oauthError === "invalid_grant" || oauthError === "invalid_token";
}

function classifyOAuthHttpFailure(
  status: number,
  oauthError: string | undefined,
): OAuthFailureClass {
  if (status === 429 || status >= 500) {
    return "upstream_auth_unavailable";
  }
  if (isReconnectRequiredOAuthError(oauthError)) {
    return "reconnect_required";
  }
  if (status >= 400 && status < 500) {
    return "provider_auth_rejected";
  }
  return "provider_response_invalid";
}

function isOAuthFailureClass(value: unknown): value is OAuthFailureClass {
  return (
    value === "reconnect_required" ||
    value === "upstream_auth_unavailable" ||
    value === "provider_auth_rejected" ||
    value === "provider_response_invalid"
  );
}

export function isOAuthFailureRetryable(
  failureClass: OAuthFailureClass,
): boolean {
  return (
    failureClass === "upstream_auth_unavailable" ||
    failureClass === "provider_response_invalid"
  );
}

export function createOAuthProviderError(
  args: CreateOAuthProviderErrorArgs,
): OAuthProviderError {
  const err = new Error(args.message);
  err.name = "OAuthProviderError";
  Object.assign(err, {
    provider: args.provider,
    operation: args.operation,
    failureClass: args.failureClass,
    retryable: isOAuthFailureRetryable(args.failureClass),
    upstreamStatus: args.upstreamStatus,
    oauthError: args.oauthError,
    oauthErrorDescription: args.oauthErrorDescription,
    refreshErrorCode: args.refreshErrorCode,
  });
  return err as OAuthProviderError;
}

export function isOAuthProviderError(
  value: unknown,
): value is OAuthProviderError {
  return (
    value instanceof Error &&
    value.name === "OAuthProviderError" &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { operation?: unknown }).operation === "string" &&
    isOAuthFailureClass((value as { failureClass?: unknown }).failureClass) &&
    typeof (value as { retryable?: unknown }).retryable === "boolean"
  );
}

function truncateRawBody(raw: string): string {
  return raw.length > MAX_BODY_LENGTH
    ? raw.slice(0, MAX_BODY_LENGTH) + "..."
    : raw;
}

/**
 * Read the response body from a failed OAuth request and throw an error
 * with full diagnostic context (status code, error reason, description).
 *
 * Attempts to parse the body as JSON to extract standard OAuth error fields
 * (`error`, `error_description`). Falls back to raw text if not JSON.
 * Truncates long bodies to avoid noisy logs.
 */
export async function throwOAuthError(
  provider: string,
  operation: OAuthTokenOperation,
  response: Response,
): Promise<never> {
  const status = response.status;
  let detail = "";
  let oauthError: string | undefined;
  let oauthErrorDescription: string | undefined;

  const raw = await response.text();
  if (raw.length > 0) {
    try {
      const json: unknown = JSON.parse(raw);
      if (typeof json === "object" && json !== null) {
        const obj = json as Record<string, unknown>;
        oauthError =
          typeof obj["error"] === "string" ? obj["error"] : undefined;
        oauthErrorDescription =
          typeof obj["error_description"] === "string"
            ? obj["error_description"]
            : undefined;
        if (oauthError) {
          detail = oauthErrorDescription
            ? ` ${oauthError} (${oauthErrorDescription})`
            : ` ${oauthError}`;
        } else {
          detail = ` ${truncateRawBody(raw)}`;
        }
      }
    } catch {
      detail = ` ${truncateRawBody(raw)}`;
    }
  }

  throw createOAuthProviderError({
    provider,
    operation,
    message: `${provider} token ${operation} failed: ${status}${detail}`,
    failureClass: classifyOAuthHttpFailure(status, oauthError),
    upstreamStatus: status,
    oauthError,
    oauthErrorDescription,
  });
}
