import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { TOKEN_PREFIXES } from "@vm0/core";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { logger } from "../logger";

const log = logger("auth:user");

/**
 * Get the current user ID from CLI token or Clerk session
 * Returns null if not authenticated
 *
 * IMPORTANT: This function rejects sandbox JWT tokens.
 * Sandbox tokens can only be used on webhook endpoints via getSandboxAuth().
 * This ensures sandbox tokens cannot access normal user APIs.
 */
export async function getUserId(): Promise<string | null> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7); // Remove "Bearer "

    // Reject sandbox tokens on normal APIs
    // They must use webhook endpoints with getSandboxAuth()
    if (isSandboxToken(token)) {
      log.debug("Rejected sandbox token on normal API endpoint");
      return null;
    }

    // Check for CLI token format (vm0_live_)
    if (token.startsWith(TOKEN_PREFIXES.CLI)) {
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

    // Not a CLI or sandbox token - must be Clerk JWT
    // Verify using Clerk auth (token is automatically verified by Clerk middleware)
    const { userId } = await auth();
    return userId;
  }

  // Fall back to Clerk session auth
  const { userId } = await auth();
  return userId;
}
