import type { VALID_CAPABILITIES } from "@vm0/core";
import type { AuthContext } from "./get-user-id";

type Capability = (typeof VALID_CAPABILITIES)[number];

/**
 * Check if an auth context has a specific capability.
 * Returns true for non-sandbox auth (CLI/session tokens have full access).
 * Returns false if sandbox token lacks the capability.
 */
export function hasCapability(
  authCtx: AuthContext,
  capability: Capability,
): boolean {
  if (!authCtx.capabilities) {
    return true;
  }
  return authCtx.capabilities.includes(capability);
}

/**
 * Check if auth context is from a sandbox token.
 * Sandbox auth contexts have a runId field.
 * Type guard narrows authCtx so callers can access runId without non-null assertion.
 */
export function isSandboxAuth(
  authCtx: AuthContext,
): authCtx is AuthContext & { runId: string } {
  return authCtx.runId !== undefined;
}

/**
 * Map storage type + action to capability string.
 * e.g., ("volume", "read") → "volume:read"
 */
export function storageCapability(
  storageType: "volume" | "artifact" | "memory",
  action: "read" | "write",
): Capability {
  return `${storageType}:${action}` as Capability;
}

/**
 * Build 403 response body for missing capability.
 * Response body tells which capability is missing (aids debugging).
 */
export function missingCapabilityError(capability: Capability): {
  error: { message: string; code: string };
} {
  return {
    error: {
      message: `Missing required capability: ${capability}`,
      code: "FORBIDDEN",
    },
  };
}
