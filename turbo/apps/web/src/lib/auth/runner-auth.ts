/**
 * Runner authentication module
 *
 * Handles authentication for runner endpoints (poll, claim).
 * Supports official runners (vm0_official_*) and user runners (vm0_live_*).
 */

import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { logger } from "../logger";
import { timingSafeEqual } from "crypto";

const log = logger("auth:runner");

/**
 * Token prefix for official runner authentication
 */
export const OFFICIAL_RUNNER_TOKEN_PREFIX = "vm0_official_";

/**
 * Runner authentication context
 * - 'user': Authenticated via CLI token, tied to a specific user
 * - 'official-runner': Authenticated via official runner secret
 */
export type RunnerAuthContext =
  | { type: "user"; userId: string }
  | { type: "official-runner" };

/**
 * Validate official runner secret using timing-safe comparison
 */
function validateOfficialRunnerSecret(providedSecret: string): boolean {
  initServices();
  const expectedSecret = globalThis.services.env.OFFICIAL_RUNNER_SECRET;

  if (!expectedSecret) {
    log.warn("OFFICIAL_RUNNER_SECRET not configured");
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    const providedBuffer = Buffer.from(providedSecret, "utf8");
    const expectedBuffer = Buffer.from(expectedSecret, "utf8");

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Get runner authentication context from request headers.
 *
 * This function handles authentication for runner endpoints (poll, claim).
 * It supports two types of authentication:
 *
 * 1. Official runner: Uses `vm0_official_<secret>` token format
 *    - Validated against OFFICIAL_RUNNER_SECRET env var
 *    - Returns { type: 'official-runner' }
 *
 * 2. User runner: Uses `vm0_live_<token>` CLI token format
 *    - Validated against cli_tokens table
 *    - Returns { type: 'user', userId }
 *
 * @returns RunnerAuthContext if authenticated, null otherwise
 */
export async function getRunnerAuth(): Promise<RunnerAuthContext | null> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Reject sandbox JWT tokens - they should only be used for webhooks
  if (isSandboxToken(token)) {
    log.debug("Rejected sandbox JWT token on runner endpoint");
    return null;
  }

  // Check for official runner token format (vm0_official_)
  if (token.startsWith(OFFICIAL_RUNNER_TOKEN_PREFIX)) {
    const secret = token.substring(OFFICIAL_RUNNER_TOKEN_PREFIX.length);

    if (validateOfficialRunnerSecret(secret)) {
      log.debug("Official runner authenticated");
      return { type: "official-runner" };
    }

    log.warn("Invalid official runner secret");
    return null;
  }

  // Check for CLI token format (vm0_live_)
  if (token.startsWith("vm0_live_")) {
    initServices();

    const [tokenRecord] = await globalThis.services.db
      .select()
      .from(cliTokens)
      .where(
        and(eq(cliTokens.token, token), gt(cliTokens.expiresAt, new Date())),
      )
      .limit(1);

    if (tokenRecord) {
      // Update last used timestamp (non-blocking)
      globalThis.services.db
        .update(cliTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(cliTokens.token, token))
        .catch((err) => log.error("Failed to update token lastUsedAt:", err));

      return { type: "user", userId: tokenRecord.userId };
    }

    return null;
  }

  // Unknown token format
  return null;
}
