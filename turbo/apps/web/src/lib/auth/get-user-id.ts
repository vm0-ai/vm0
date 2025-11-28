import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { eq, and, gt } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { logger } from "../logger";

const log = logger("auth:user");

/**
 * Get the current user ID from CLI token or Clerk session
 * Returns null if not authenticated
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

      return tokenRecord.userId;
    }

    return null;
  }

  // Fall back to Clerk session auth
  const { userId } = await auth();
  return userId;
}
