import type { VALID_CAPABILITIES } from "@vm0/core";
import { getAuthContext, type AuthContext } from "./get-user-id";
import { isSandboxToken, verifySandboxToken } from "./sandbox-token";
import { missingCapabilityError } from "./capability-check";

type Capability = (typeof VALID_CAPABILITIES)[number];

type AuthErrorResponse = {
  status: 401 | 403;
  body: { error: { message: string; code: string } };
};

/**
 * Authenticate a request, distinguishing 401 (not authenticated) from 403
 * (valid sandbox token but missing capability).
 *
 * Returns AuthContext on success, or a ready-to-return error response.
 */
export async function requireAuth(
  authHeader: string | undefined,
  options?: {
    requiredCapability?: Capability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<AuthContext | AuthErrorResponse> {
  const authCtx = await getAuthContext(authHeader, options);

  if (authCtx) {
    return authCtx;
  }

  // getAuthContext returned null — determine if it's 401 or 403.
  // If the token is a structurally valid, non-expired sandbox JWT,
  // then the user IS authenticated but lacks the required capability.
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (isSandboxToken(token)) {
      const sandboxAuth = verifySandboxToken(token);
      if (sandboxAuth) {
        // Token is valid → this is a capability/access issue, not auth
        if (options?.requiredCapability) {
          return {
            status: 403 as const,
            body: missingCapabilityError(options.requiredCapability),
          };
        }
        // Uncovered endpoint or acceptAnySandboxCapability without capabilities
        return {
          status: 403 as const,
          body: {
            error: {
              message: "This endpoint is not available for sandbox tokens",
              code: "FORBIDDEN",
            },
          },
        };
      }
    }
  }

  // Genuinely not authenticated
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

/**
 * Type guard to check if requireAuth result is an error response.
 */
export function isAuthError(
  result: AuthContext | AuthErrorResponse,
): result is AuthErrorResponse {
  return "status" in result;
}
