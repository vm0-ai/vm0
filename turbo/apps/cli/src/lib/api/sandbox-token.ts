import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { getOkouToken } from "../okou-env.js";

export interface SandboxTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: "okou";
  capabilities: string[];
  publicBrand?: PublicBrand;
  iat: number;
  exp: number;
}

/**
 * Decode an OKOU_TOKEN JWT payload.
 * Only decodes — does NOT verify signature (server does that).
 * If no token is provided, reads OKOU_TOKEN.
 * Returns undefined if the token is missing, malformed, or has an unsupported scope.
 */
export function decodeSandboxTokenPayload(
  token?: string,
): SandboxTokenPayload | undefined {
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
    ) as SandboxTokenPayload;
    const publicBrandIsValid =
      payload.publicBrand === undefined ||
      payload.publicBrand === "vm0" ||
      payload.publicBrand === "okou";
    if (
      payload.scope === "okou" &&
      Array.isArray(payload.capabilities) &&
      publicBrandIsValid
    ) {
      return payload;
    }
  } catch {
    // Malformed token — fall through
  }
  return undefined;
}
