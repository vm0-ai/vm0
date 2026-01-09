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
import { TOKEN_PREFIXES } from "@vm0/core";
import { logger } from "../logger";
import { missingApiKeyError, invalidApiKeyError } from "./errors";
import type { TsRestResponse } from "@ts-rest/serverless";

const log = logger("public-api:auth");

/**
 * Authentication result for public API
 */
export interface PublicApiAuth {
  userId: string;
  tokenId: string | null; // null for CLI tokens
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
      // Token is invalid or expired
      return invalidApiKeyError();
    }

    log.debug("Authenticated with API token", {
      tokenId: result.id,
      userId: result.userId,
    });

    return {
      userId: result.userId,
      tokenId: result.id,
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

    return {
      userId,
      tokenId: null,
      tokenType: "cli",
    };
  }

  // Unknown token format
  return invalidApiKeyError();
}

/**
 * Type guard to check if result is an authentication success
 */
export function isAuthSuccess(
  result: PublicApiAuth | TsRestResponse,
): result is PublicApiAuth {
  return "userId" in result && typeof result.userId === "string";
}
