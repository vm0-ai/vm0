import { eq, and, gt } from "drizzle-orm";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { getAuthProvider } from "./auth-provider";
import { logger } from "../logger";

const log = logger("auth:user");

/**
 * Get the current user ID from CLI token or auth provider session.
 * Returns null if not authenticated.
 *
 * @param authHeader - The Authorization header value (optional)
 *
 * IMPORTANT: This function rejects sandbox JWT tokens.
 * Sandbox tokens can only be used on webhook endpoints via getSandboxAuth().
 * This ensures sandbox tokens cannot access normal user APIs.
 */
export async function getUserId(authHeader?: string): Promise<string | null> {
  // Session auth via provider (Clerk or local single-user)
  const provider = getAuthProvider();
  const userId = await provider.getUserId();
  if (userId) {
    return userId;
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Reject sandbox JWT tokens on normal APIs
  // They must use webhook endpoints with getSandboxAuth()
  if (isSandboxToken(token)) {
    log.debug("Rejected sandbox JWT token on normal API endpoint");
    return null;
  }

  // Check for CLI token format (vm0_live_)
  if (!token.startsWith("vm0_live_")) {
    return null;
  }

  const [tokenRecord] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(and(eq(cliTokens.token, token), gt(cliTokens.expiresAt, new Date())))
    .limit(1);

  if (!tokenRecord) {
    return null;
  }

  // Update last used timestamp (non-blocking)
  globalThis.services.db
    .update(cliTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(cliTokens.token, token))
    .catch((err) => log.error("Failed to update token lastUsedAt:", err));

  return tokenRecord.userId;
}

/**
 * Get user ID from a Request object
 * Used for API routes that receive the full Request
 */
export async function getUserIdFromRequest(
  request: Request,
): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? undefined;
  return getUserId(authHeader);
}
