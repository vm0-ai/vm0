import type { AuthContext } from "./get-user-id";

/**
 * Check if an auth context has a specific capability.
 * Returns true for non-sandbox auth (CLI/session tokens have full access).
 * Returns false if sandbox token lacks the capability.
 */
export function hasCapability(
  authCtx: AuthContext,
  capability: string,
): boolean {
  if (!authCtx.capabilities) {
    return true;
  }
  return authCtx.capabilities.includes(capability);
}

/**
 * Type guard: check if auth context is from a sandbox token.
 * Sandbox auth contexts have a runId field.
 */
export function isSandboxAuth(authCtx: AuthContext): boolean {
  return authCtx.runId !== undefined;
}

/**
 * Map storage type + action to capability string.
 * e.g., ("volume", "read") → "volume:read"
 */
export function storageCapability(
  storageType: "volume" | "artifact" | "memory",
  action: "read" | "write",
): string {
  return `${storageType}:${action}`;
}

/**
 * Build 403 response body for missing capability.
 * Response body tells which capability is missing (aids debugging).
 */
export function missingCapabilityError(capability: string): {
  error: { message: string; code: string };
} {
  return {
    error: {
      message: `Missing required capability: ${capability}`,
      code: "FORBIDDEN",
    },
  };
}
