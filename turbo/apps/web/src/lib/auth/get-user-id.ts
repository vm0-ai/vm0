import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { logger } from "../logger";

const log = logger("auth:user");

/**
 * Get the current user ID from Clerk session or CLI token
 * Returns null if not authenticated
 *
 * Priority:
 * 1. Clerk session auth (for web users)
 * 2. CLI token auth (for CLI/API users)
 *
 * IMPORTANT: This function rejects sandbox JWT tokens.
 * Sandbox tokens can only be used on webhook endpoints via getSandboxAuth().
 * This ensures sandbox tokens cannot access normal user APIs.
 */
export async function getUserId(): Promise<string | null> {
  // Check Clerk session first - most web users are authenticated via Clerk
  // This avoids unnecessary header parsing and database queries
  const { userId } = await auth();
  if (userId) {
    return userId;
  }

  // Fall back to Authorization header for CLI tokens
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
    }
  }

  return null;
}
