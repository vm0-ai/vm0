/**
 * Public API v1 Authentication
 *
 * Handles authentication for the public API, supporting both:
 * - API tokens (vm0_api_*) - New, for public API
 * - CLI tokens (vm0_live_*) - Existing, for CLI backward compatibility
 */
import { headers } from "next/headers";
import { validateApiToken } from "../api-token";
import { getUserId } from "../auth/get-user-id";
import { TOKEN_PREFIXES, type ApiScope } from "@vm0/core";
import { logger } from "../logger";
import {
  missingApiKeyError,
  invalidApiKeyError,
  insufficientScopeError,
} from "./errors";
import type { TsRestResponse } from "@ts-rest/serverless";

const log = logger("public-api:auth");

/**
 * Authentication result for public API
 */
export interface PublicApiAuth {
  userId: string;
  tokenId: string | null; // null for CLI tokens
  scopes: ApiScope[];
  tokenType: "api" | "cli";
}

/**
 * Authenticate a public API request
 *
 * Supports both API tokens (vm0_api_*) and CLI tokens (vm0_live_*).
 *
 * @returns Authentication result or TsRestResponse error
 */
export async function authenticatePublicApi(): Promise<
  PublicApiAuth | TsRestResponse
> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return missingApiKeyError();
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Check for API token (vm0_api_*)
  if (token.startsWith(TOKEN_PREFIXES.API)) {
    const result = await validateApiToken(token);

    if (!result) {
      // Token is invalid, expired, or revoked
      // We can't distinguish between invalid and expired without extra DB query
      return invalidApiKeyError();
    }

    log.debug("Authenticated with API token", {
      tokenId: result.id,
      userId: result.userId,
    });

    return {
      userId: result.userId,
      tokenId: result.id,
      scopes: result.scopes,
      tokenType: "api",
    };
  }

  // Check for CLI token (vm0_live_*)
  if (token.startsWith(TOKEN_PREFIXES.CLI)) {
    const userId = await getUserId();

    if (!userId) {
      return invalidApiKeyError();
    }

    log.debug("Authenticated with CLI token", { userId });

    // CLI tokens have all scopes by default
    return {
      userId,
      tokenId: null,
      scopes: Object.keys(
        await import("@vm0/core").then((m) => m.API_SCOPES),
      ) as ApiScope[],
      tokenType: "cli",
    };
  }

  // Unknown token format
  return invalidApiKeyError();
}

/**
 * Check if the authenticated user has the required scope
 *
 * @returns true if authorized, TsRestResponse error if not
 */
export function requireScope(
  auth: PublicApiAuth,
  requiredScope: ApiScope,
): true | TsRestResponse {
  if (!auth.scopes.includes(requiredScope)) {
    log.warn("Insufficient scope", {
      userId: auth.userId,
      tokenId: auth.tokenId,
      requiredScope,
      availableScopes: auth.scopes,
    });
    return insufficientScopeError(requiredScope);
  }
  return true;
}

/**
 * Check if the authenticated user has any of the required scopes
 *
 * @returns true if authorized, TsRestResponse error if not
 */
export function requireAnyScope(
  auth: PublicApiAuth,
  requiredScopes: ApiScope[],
): true | TsRestResponse {
  const hasAny = requiredScopes.some((scope) => auth.scopes.includes(scope));
  if (!hasAny) {
    log.warn("Insufficient scope (any)", {
      userId: auth.userId,
      tokenId: auth.tokenId,
      requiredScopes,
      availableScopes: auth.scopes,
    });
    return insufficientScopeError(requiredScopes.join(" or "));
  }
  return true;
}

/**
 * Check if the authenticated user has all of the required scopes
 *
 * @returns true if authorized, TsRestResponse error if not
 */
export function requireAllScopes(
  auth: PublicApiAuth,
  requiredScopes: ApiScope[],
): true | TsRestResponse {
  const hasAll = requiredScopes.every((scope) => auth.scopes.includes(scope));
  if (!hasAll) {
    const missingScopes = requiredScopes.filter(
      (scope) => !auth.scopes.includes(scope),
    );
    log.warn("Insufficient scope (all)", {
      userId: auth.userId,
      tokenId: auth.tokenId,
      requiredScopes,
      missingScopes,
      availableScopes: auth.scopes,
    });
    return insufficientScopeError(missingScopes.join(", "));
  }
  return true;
}

/**
 * Type guard to check if result is an authentication success
 */
export function isAuthSuccess(
  result: PublicApiAuth | TsRestResponse,
): result is PublicApiAuth {
  return "userId" in result && typeof result.userId === "string";
}

/**
 * Type guard to check if result is an authorization success
 */
export function isAuthorized(result: true | TsRestResponse): result is true {
  return result === true;
}
