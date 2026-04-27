import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type { AuthContext } from "./get-auth-context";

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
 * Build 403 response body for missing capability.
 * Response body tells which capability is missing (aids debugging).
 */
export function missingCapabilityError(capability: ZeroCapability): {
  error: { message: string; code: string };
} {
  return {
    error: {
      message: `Missing required capability: ${capability}`,
      code: "FORBIDDEN",
    },
  };
}
