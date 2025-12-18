import { headers } from "next/headers";
import {
  verifySandboxToken,
  isSandboxToken,
  type SandboxAuth,
} from "./sandbox-token";
import { logger } from "../logger";

const log = logger("auth:sandbox");

/**
 * Get sandbox authentication from JWT token in Authorization header
 *
 * This function is specifically for webhook endpoints that should only
 * accept sandbox JWT tokens. It verifies:
 * 1. The token is a valid JWT (not a regular CLI token)
 * 2. The token signature is valid
 * 3. The token has not expired
 * 4. The token has the correct scope ("sandbox")
 *
 * Returns null if:
 * - No Authorization header
 * - Token is not a JWT (regular CLI tokens are rejected)
 * - Token is invalid or expired
 *
 * @returns SandboxAuth with userId and runId, or null if not authenticated
 */
export async function getSandboxAuth(): Promise<SandboxAuth | null> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Only accept JWT tokens (sandbox tokens)
  // Regular CLI tokens (vm0_live_xxx) are rejected
  if (!isSandboxToken(token)) {
    log.debug("Rejected non-JWT token on webhook endpoint");
    return null;
  }

  const auth = verifySandboxToken(token);
  if (!auth) {
    log.debug("Invalid or expired sandbox token");
    return null;
  }

  return auth;
}

/**
 * Get sandbox authentication and verify it matches the expected runId
 *
 * This is a stricter version that ensures the token's runId matches
 * the runId in the request body. Use this when the endpoint receives
 * a runId in the request and needs to verify the token is authorized
 * for that specific run.
 *
 * @param expectedRunId - The runId from the request body to verify against
 * @returns SandboxAuth if valid and runId matches, null otherwise
 */
export async function getSandboxAuthForRun(
  expectedRunId: string,
): Promise<SandboxAuth | null> {
  const auth = await getSandboxAuth();
  if (!auth) {
    return null;
  }

  // Verify the token's runId matches the expected runId
  if (auth.runId !== expectedRunId) {
    log.debug(
      `Token runId mismatch: expected ${expectedRunId}, got ${auth.runId}`,
    );
    return null;
  }

  return auth;
}
