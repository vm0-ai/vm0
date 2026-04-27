import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { getAuthContext, type AuthContext } from "./get-auth-context";
import {
  isPatToken,
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
 * Strict authenticator for the public `/api/v1/*` surface: the caller must
 * present a `vm0_pat_…` personal access token minted from `/settings/api-keys`
 * (or the CLI device flow — the same token artifact). Session cookies,
 * sandbox/zero tokens, and any other bearer shape are rejected so these
 * endpoints can never be reached without an explicit, user-created PAT.
 *
 * The PAT JWT carries the orgId stamped at mint time, so `resolveOrg` has
 * explicit org context without a session lookup. We additionally re-check
 * that the user is still a member of that org — a PAT must not outlive
 * membership.
 *
 * Missing/invalid/revoked/expired keys (or keys whose user left the org)
 * return 401.
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
  if (!isPatToken(token)) return unauthorized;
  const authCtx = await getAuthContext(authHeader);
  if (!authCtx) return unauthorized;
  if (authCtx.tokenType !== "pat") return unauthorized;
  if (!authCtx.orgId) return unauthorized;
  return authCtx;
}
