import { eq, and, gt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken } from "./sandbox-token";
import { logger } from "../logger";

const log = logger("auth:user");

/**
 * Authentication context returned by getAuthContext.
 * - scopeId: present when auth is via a CLI token that has a stored scope
 */
type AuthContext = {
  userId: string;
  scopeId: string | null;
};

/**
 * Get the full authentication context from CLI token or Clerk session.
 * Returns null if not authenticated.
 *
 * For Clerk sessions, scopeId is null (scope is resolved from JWT orgId).
 * For CLI tokens with scope_id, returns the stored scopeId.
 *
 * IMPORTANT: This function rejects sandbox JWT tokens.
 * Sandbox tokens can only be used on webhook endpoints via getSandboxAuth().
 */
export async function getAuthContext(
  authHeader?: string,
): Promise<AuthContext | null> {
  // Session auth via Clerk
  const { userId } = await auth();
  if (userId) {
    return { userId, scopeId: null };
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Reject sandbox JWT tokens on normal APIs
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

  return { userId: tokenRecord.userId, scopeId: tokenRecord.scopeId };
}

/**
 * Get the current user ID from CLI token or Clerk session.
 * Returns null if not authenticated.
 *
 * Use getAuthContext() when you also need the CLI token's scopeId.
 */
export async function getUserId(authHeader?: string): Promise<string | null> {
  const ctx = await getAuthContext(authHeader);
  return ctx?.userId ?? null;
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
