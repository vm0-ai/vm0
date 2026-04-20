import type { ZeroCapability } from "@vm0/core";
import {
  authenticateClerkApiKey,
  getAuthContext,
  type AuthContext,
} from "./get-auth-context";
import {
  isSandboxToken,
  verifySandboxToken,
  verifyZeroToken,
} from "./sandbox-token";
import { missingCapabilityError } from "./capability-check";

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
    requiredCapability?: ZeroCapability;
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
      const zeroAuth = !sandboxAuth ? verifyZeroToken(token) : null;
      if (sandboxAuth || zeroAuth) {
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

/**
 * Strict authenticator for the public `/api/v1/*` surface: any valid
 * Clerk-issued API Key for the caller's user acts as a personal access token.
 * Session cookies, CLI PAT (`vm0_pat_`), and sandbox/zero tokens are all
 * rejected so these endpoints can never be reached without an explicit,
 * user-created Clerk API key. Verifies the key directly via
 * `clerkClient.apiKeys.verify` and never consults Clerk's session, so it is
 * safe to use under routes where `clerkMiddleware` has been bypassed.
 *
 * Missing/invalid/revoked/expired keys return 401.
 */
export async function requireApiKeyAuth(
  authHeader: string | undefined,
): Promise<AuthContext | AuthErrorResponse> {
  const unauthorized: AuthErrorResponse = {
    status: 401 as const,
    body: {
      error: { message: "API key required", code: "UNAUTHORIZED" },
    },
  };
  if (!authHeader?.startsWith("Bearer ")) return unauthorized;
  const token = authHeader.substring(7);
  // Reject any self-signed prefix on this surface — v1 is api_key only.
  if (token.startsWith("vm0_")) return unauthorized;
  const authCtx = await authenticateClerkApiKey(token);
  if (!authCtx) return unauthorized;
  return authCtx;
}
