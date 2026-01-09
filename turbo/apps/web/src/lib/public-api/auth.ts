/**
 * Public API v1 Authentication
 *
 * Handles authentication for the public API using CLI tokens (vm0_live_*).
 */
import { getUserId } from "../auth/get-user-id";
import { logger } from "../logger";
import { invalidApiKeyError } from "./errors";
import type { TsRestResponse } from "@ts-rest/serverless";

const log = logger("public-api:auth");

/**
 * Authentication result for public API
 */
export interface PublicApiAuth {
  userId: string;
}

/**
 * Authenticate a public API request
 *
 * Uses CLI tokens (vm0_live_*) for authentication.
 *
 * @returns Authentication result or TsRestResponse error
 */
export async function authenticatePublicApi(): Promise<
  PublicApiAuth | TsRestResponse
> {
  const userId = await getUserId();

  if (!userId) {
    // getUserId returns null for missing/invalid tokens
    return invalidApiKeyError();
  }

  log.debug("Authenticated", { userId });

  return { userId };
}

/**
 * Type guard to check if result is an authentication success
 */
export function isAuthSuccess(
  result: PublicApiAuth | TsRestResponse,
): result is PublicApiAuth {
  return "userId" in result && typeof result.userId === "string";
}
