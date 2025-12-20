import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { logger } from "../logger";
import { isCommunityEdition } from "../edition";

const log = logger("auth:user");

/**
 * Community Edition authentication
 * - If VM0_COMMUNITY_AUTH_TOKEN is set: require Bearer token match
 * - If not set: open access, return fixed userId
 */
async function getCommunityUserId(): Promise<string | null> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");
  const communityToken = process.env.VM0_COMMUNITY_AUTH_TOKEN;

  if (communityToken) {
    // Token configured - require authentication
    if (authHeader === `Bearer ${communityToken}`) {
      return "community_edition";
    }
    log.debug("Community Edition: token mismatch or missing");
    return null;
  }

  // No token configured - open access
  return "community_edition";
}

/**
 * Get the current user ID from CLI token or Clerk session
 * Returns null if not authenticated
 *
 * IMPORTANT: This function rejects sandbox JWT tokens.
 * Sandbox tokens can only be used on webhook endpoints via getSandboxAuth().
 * This ensures sandbox tokens cannot access normal user APIs.
 */
export async function getUserId(): Promise<string | null> {
  // Community Edition: simple token-based or open auth
  if (isCommunityEdition()) {
    return getCommunityUserId();
  }

  // Cloud Edition: CLI token or Clerk session auth
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7); // Remove "Bearer "

    // Reject sandbox JWT tokens on normal APIs
    // They must use webhook endpoints with getSandboxAuth()
    if (isSandboxToken(token)) {
      log.debug("Rejected sandbox JWT token on normal API endpoint");
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

        return tokenRecord.userId;
      }

      return null;
    }

    // Unknown token format
    return null;
  }

  // Fall back to Clerk session auth (dynamic import to avoid build issues in Community Edition)
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  return userId;
}
