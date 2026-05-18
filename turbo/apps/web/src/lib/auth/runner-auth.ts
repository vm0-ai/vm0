/**
 * Runner authentication module
 *
 * Handles authentication for runner endpoints (poll, claim).
 * Supports official runners (vm0_official_*) and user runners (via CLI JWT tokens).
 */

import { initServices } from "../init-services";
import { isPatToken, verifyCliToken } from "./sandbox-token";
import { resolveCliTokenFromDb } from "./get-auth-context";
import { logger } from "../shared/logger";
import { timingSafeEqual } from "crypto";

const log = logger("auth:runner");

/**
 * Token prefix for official runner authentication
 */
const OFFICIAL_RUNNER_TOKEN_PREFIX = "vm0_official_";

/**
 * Runner authentication context
 * - 'user': Authenticated via CLI token, tied to a specific user
 * - 'official-runner': Authenticated via official runner secret
 */
type RunnerAuthContext =
  | {
      type: "user";
      userId: string;
    }
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
 * 2. User runner: Uses CLI JWT token (`vm0_pat_` prefix with scope "cli")
 *    - Validated via JWT signature + cli_tokens table revocation check
 *    - Returns { type: 'user', userId }
 *
 * @param authHeader - The Authorization header value (optional)
 * @returns RunnerAuthContext if authenticated, null otherwise
 */
export async function getRunnerAuth(
  authHeader?: string,
): Promise<RunnerAuthContext | null> {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Handle PAT tokens (vm0_pat_ prefix — CLI personal access tokens)
  if (isPatToken(token)) {
    const cliAuth = verifyCliToken(token);
    if (cliAuth) {
      initServices();
      const resolved = await resolveCliTokenFromDb(cliAuth);
      if (!resolved) {
        return null;
      }
      return { type: "user", userId: resolved.userId };
    }
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

  // Unknown token format
  return null;
}
