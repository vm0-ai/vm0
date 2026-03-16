import type { VALID_CAPABILITIES } from "@vm0/core";
import type { AuthContext } from "./get-user-id";

type Capability = (typeof VALID_CAPABILITIES)[number];

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
 * Map storage action to unified capability string.
 */
export function storageCapability(action: "read" | "write"): Capability {
  return `storage:${action}` as Capability;
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
