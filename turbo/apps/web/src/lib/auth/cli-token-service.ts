import crypto from "crypto";
import { cliTokens } from "../../db/schema/cli-tokens";

/**
 * Generate an ephemeral CLI token for server-side operations.
 * The token follows the standard vm0_live_* format and passes getUserId() validation.
 *
 * @param userId - The Clerk user ID to associate with the token
 * @returns The generated token string (vm0_live_*)
 */
export async function generateEphemeralCliToken(
  userId: string,
): Promise<string> {
  const token = `vm0_live_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await globalThis.services.db.insert(cliTokens).values({
    token,
    userId,
    name: "slack-compose-ephemeral",
    expiresAt,
  });

  return token;
}
