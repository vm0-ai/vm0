const MAX_BODY_LENGTH = 500;

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
  operation: string,
  response: Response,
): Promise<never> {
  const status = response.status;
  let detail = "";

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
        if (errorCode) {
          detail = errorDesc ? ` ${errorCode} (${errorDesc})` : ` ${errorCode}`;
        } else {
          const truncated =
            raw.length > MAX_BODY_LENGTH
              ? raw.slice(0, MAX_BODY_LENGTH) + "..."
              : raw;
          detail = ` ${truncated}`;
        }
      }
    } catch {
      const truncated =
        raw.length > MAX_BODY_LENGTH
          ? raw.slice(0, MAX_BODY_LENGTH) + "..."
          : raw;
      detail = ` ${truncated}`;
    }
  }

  throw new Error(`${provider} token ${operation} failed: ${status}${detail}`);
}
