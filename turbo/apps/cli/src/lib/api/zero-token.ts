import { getOkouToken } from "../okou-env.js";

export interface ZeroTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: "zero" | "okou";
  capabilities: string[];
  iat: number;
  exp: number;
}

/**
 * Decode an OKOU_TOKEN or ZERO_TOKEN JWT payload.
 * Only decodes — does NOT verify signature (server does that).
 * If no token is provided, reads OKOU_TOKEN with ZERO_TOKEN as a fallback.
 * Returns undefined if the token is missing, malformed, or has an unsupported scope.
 */
export function decodeZeroTokenPayload(
  token?: string,
): ZeroTokenPayload | undefined {
  const raw = token ?? getOkouToken();
  if (!raw) return undefined;

  const prefix = "vm0_sandbox_";
  if (!raw.startsWith(prefix)) return undefined;
  const jwt = raw.slice(prefix.length);

  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as ZeroTokenPayload;
    if (
      (payload.scope === "zero" || payload.scope === "okou") &&
      Array.isArray(payload.capabilities)
    ) {
      return payload;
    }
  } catch {
    // Malformed token — fall through
  }
  return undefined;
}
