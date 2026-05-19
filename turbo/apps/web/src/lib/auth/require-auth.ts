import { after } from "next/server";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { getAuthContext, type AuthContext } from "./get-auth-context";
import {
  isSandboxToken,
  verifySandboxToken,
  verifyZeroToken,
} from "./sandbox-token";
import { missingCapabilityError } from "./capability-check";
import { shadowCompareAuth } from "./shadow-check";

type AuthErrorResponse = {
  status: 401 | 403;
  body: { error: { message: string; code: string } };
};

function scheduleShadowCheck(
  result: AuthContext | AuthErrorResponse,
  authHeader: string | undefined,
  cookieHeader?: string,
  authOptions?: {
    requiredCapability?: string;
    acceptAnySandboxCapability?: boolean;
    accept?: string;
  },
): void {
  try {
    after(async () => {
      await shadowCompareAuth(result, {
        authHeader,
        cookieHeader,
        ...authOptions,
      });
    });
  } catch {
    // Outside a Next.js request scope (e.g. unit tests) — skip silently.
  }
}

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
    cookieHeader?: string;
  },
): Promise<AuthContext | AuthErrorResponse> {
  const cookieHeader = options?.cookieHeader;
  const shadowOpts = {
    requiredCapability: options?.requiredCapability,
    acceptAnySandboxCapability: options?.acceptAnySandboxCapability,
  };
  const authCtx = await getAuthContext(authHeader, options);

  if (authCtx) {
    scheduleShadowCheck(authCtx, authHeader, cookieHeader, shadowOpts);
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
        const capabilityErr: AuthErrorResponse = options?.requiredCapability
          ? {
              status: 403 as const,
              body: missingCapabilityError(options.requiredCapability),
            }
          : {
              status: 403 as const,
              body: {
                error: {
                  message: "This endpoint is not available for sandbox tokens",
                  code: "FORBIDDEN",
                },
              },
            };
        scheduleShadowCheck(
          capabilityErr,
          authHeader,
          cookieHeader,
          shadowOpts,
        );
        return capabilityErr;
      }
    }
  }

  // Genuinely not authenticated
  const unauthorized: AuthErrorResponse = {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
  scheduleShadowCheck(unauthorized, authHeader, cookieHeader, shadowOpts);
  return unauthorized;
}

/**
 * Type guard to check if requireAuth result is an error response.
 */
export function isAuthError(
  result: AuthContext | AuthErrorResponse,
): result is AuthErrorResponse {
  return "status" in result;
}
