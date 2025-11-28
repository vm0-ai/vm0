import { randomBytes } from "crypto";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { eq, and, lt } from "drizzle-orm";
import { logger } from "../logger";

const log = logger("auth:sandbox");

/**
 * Generate a temporary CLI token for E2B sandbox
 * Token is valid for 2 hours (longer than typical sandbox timeout)
 */
export async function generateSandboxToken(
  userId: string,
  runId: string,
): Promise<string> {
  initServices();

  // Clean up expired tokens before creating new one
  await cleanupExpiredSandboxTokens(userId);

  // Generate secure token with same format as regular CLI tokens
  const randomBytesValue = randomBytes(32);
  const token = `vm0_live_${randomBytesValue.toString("base64url")}`;

  // Store token in database with 2 hour expiration
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours

  await globalThis.services.db.insert(cliTokens).values({
    token,
    userId,
    name: `E2B Sandbox - ${runId.substring(0, 8)}`,
    expiresAt,
    createdAt: now,
  });

  log.debug(`Generated sandbox token for run ${runId}`);
  return token;
}

/**
 * Clean up expired sandbox tokens for a user
 */
async function cleanupExpiredSandboxTokens(userId: string): Promise<void> {
  initServices();

  await globalThis.services.db
    .delete(cliTokens)
    .where(
      and(eq(cliTokens.userId, userId), lt(cliTokens.expiresAt, new Date())),
    );

  log.debug(`Cleaned up expired sandbox tokens for user ${userId}`);
}
