interface CliTokenPayload {
  userId: string;
  orgId: string;
  tokenId: string;
  scope: string;
  iat: number;
  exp: number;
}

/**
 * Decode a CLI JWT token payload.
 * Only decodes — does NOT verify signature (server does that).
 * Returns undefined if token is missing, malformed, or not a cli-scoped token.
 */
export function decodeCliTokenPayload(
  token?: string,
): CliTokenPayload | undefined {
  const raw = token ?? undefined;
  if (!raw) return undefined;

  const patPrefix = "vm0_pat_";

  let jwt: string;
  if (raw.startsWith(patPrefix)) {
    jwt = raw.slice(patPrefix.length);
  } else {
    return undefined;
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as CliTokenPayload;
    if (payload.scope === "cli" && payload.orgId && payload.userId) {
      return payload;
    }
  } catch {
    // Malformed token
  }
  return undefined;
}
