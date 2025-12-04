import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { logger } from "../logger";
import { canEnableDebug } from "./check-debug-access";
import { debugContext } from "../debug-context";

const log = logger("auth:user");

/**
 * Check and enable debug mode for the current request if conditions are met.
 * Sets the debug context for the request lifecycle.
 *
 * @param userId - The authenticated user's ID
 * @param headersList - The request headers
 */
async function checkAndEnableDebug(
  userId: string,
  headersList: Headers,
): Promise<void> {
  const debugHeader = headersList.get("x-vm0-debug");

  if (debugHeader === "true") {
    const canDebug = await canEnableDebug(userId);
    if (canDebug) {
      // Enter debug context for this request
      // Note: This sets up the context but the actual wrapping happens at the route level
      const store = debugContext.getStore();
      if (store) {
        store.enabled = true;
      }
    }
  }
}

/**
 * Get the current user ID from CLI token or Clerk session
 * Returns null if not authenticated
 *
 * Also checks for debug mode header and enables debug logging for @vm0.ai users.
 */
export async function getUserId(): Promise<string | null> {
  const headersList = await headers();
  const authHeader = headersList.get("Authorization");

  // Check for CLI token format (vm0_live_)
  if (authHeader?.startsWith("Bearer vm0_live_")) {
    initServices();
    const token = authHeader.substring(7); // Remove "Bearer "

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

      // Check and enable debug mode for @vm0.ai users
      await checkAndEnableDebug(tokenRecord.userId, headersList);

      return tokenRecord.userId;
    }

    return null;
  }

  // Fall back to Clerk session auth
  const { userId } = await auth();

  // Check and enable debug mode for @vm0.ai users (browser sessions too)
  if (userId) {
    await checkAndEnableDebug(userId, headersList);
  }

  return userId;
}
