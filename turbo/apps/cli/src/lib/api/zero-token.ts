import type { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

export interface ZeroTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: string;
  capabilities: string[];
  featureSwitchOverrides?: Partial<Record<FeatureSwitchKey, boolean>>;
  iat: number;
  exp: number;
}

function normalizeZeroCapability(capability: string): string {
  switch (capability) {
    case "chat-message:read": {
      return "chat-event:read";
    }
    case "chat-message:write": {
      return "chat-event:write";
    }
    default: {
      return capability;
    }
  }
}

/**
 * Decode a ZERO_TOKEN JWT payload.
 * Only decodes — does NOT verify signature (server does that).
 * If no token is provided, reads from process.env.ZERO_TOKEN.
 * Returns undefined if token is missing, malformed, or not a zero-scoped token.
 */
export function decodeZeroTokenPayload(
  token?: string,
): ZeroTokenPayload | undefined {
  const raw = token ?? process.env.ZERO_TOKEN;
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
    if (payload.scope === "zero" && Array.isArray(payload.capabilities)) {
      return {
        ...payload,
        capabilities: payload.capabilities.map(normalizeZeroCapability),
      };
    }
  } catch {
    // Malformed token — fall through
  }
  return undefined;
}
