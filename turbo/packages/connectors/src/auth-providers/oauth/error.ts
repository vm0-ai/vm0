import { ProviderHttpError } from "../provider-error";

const MAX_DIAGNOSTIC_LENGTH = 500;

export class OAuthProviderHttpError extends ProviderHttpError {
  readonly oauthError: string | undefined;
  readonly oauthErrorSubtype: string | undefined;

  constructor(
    message: string,
    status: number,
    oauthError: string | undefined = undefined,
    oauthErrorSubtype: string | undefined = undefined,
  ) {
    super(message, status);
    this.name = "OAuthProviderHttpError";
    this.oauthError = oauthError;
    this.oauthErrorSubtype = oauthErrorSubtype;
  }
}

export function isOAuthProviderHttpError(
  value: unknown,
): value is OAuthProviderHttpError {
  return value instanceof OAuthProviderHttpError;
}

/**
 * Read the response body from a failed OAuth request and throw an error
 * with diagnostic context (status code, error reason, description).
 *
 * Attempts to parse the body as JSON to extract standard OAuth error fields
 * (`error`, `error_description`) and provider-specific subtype details
 * (`error_subtype`). Falls back to raw text if not JSON.
 * Truncates long provider-controlled diagnostics to avoid noisy logs.
 */
export async function throwOAuthError(
  provider: string,
  operation: string,
  response: Response,
): Promise<never> {
  const status = response.status;
  let detail = "";
  let oauthError: string | undefined;
  let oauthErrorSubtype: string | undefined;

  const raw = await response.text();
  if (raw.length > 0) {
    try {
      const json: unknown = JSON.parse(raw);
      if (typeof json === "object" && json !== null) {
        const obj = json as Record<string, unknown>;
        const errorCode =
          typeof obj["error"] === "string" ? obj["error"] : null;
        const errorDesc =
          typeof obj["error_description"] === "string"
            ? obj["error_description"]
            : null;
        const errorSubtype =
          typeof obj["error_subtype"] === "string"
            ? obj["error_subtype"]
            : null;
        if (errorCode) {
          oauthError = errorCode;
          oauthErrorSubtype = errorSubtype ?? undefined;
          detail = oauthErrorDetail(errorCode, errorDesc);
        } else {
          detail = responseBodyDetail(raw);
        }
      } else {
        detail = responseBodyDetail(raw);
      }
    } catch {
      detail = responseBodyDetail(raw);
    }
  }

  throw new OAuthProviderHttpError(
    `${provider} token ${operation} failed: ${status}${detail}`,
    status,
    oauthError,
    oauthErrorSubtype,
  );
}

function oauthErrorDetail(
  errorCode: string,
  errorDescription: string | null,
): string {
  const code = truncatedDiagnostic(errorCode);
  return errorDescription
    ? ` ${code} (${truncatedDiagnostic(errorDescription)})`
    : ` ${code}`;
}

function responseBodyDetail(raw: string): string {
  return ` ${truncatedDiagnostic(raw)}`;
}

function truncatedDiagnostic(value: string): string {
  return value.length > MAX_DIAGNOSTIC_LENGTH
    ? `${value.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
    : value;
}
