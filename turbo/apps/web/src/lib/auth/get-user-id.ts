import { eq, and, gt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import type { VALID_CAPABILITIES } from "@vm0/core";
import { cliTokens } from "../../db/schema/cli-tokens";
import { isSandboxToken, verifySandboxToken } from "./sandbox-token";
import { logger } from "../logger";

type Capability = (typeof VALID_CAPABILITIES)[number];

const log = logger("auth:user");

/**
 * Authentication context returned by getAuthContext.
 */
export type AuthContext = {
  userId: string;
  capabilities?: readonly Capability[];
  runId?: string;
};

/**
 * Get the full authentication context from CLI token or Clerk session.
 * Returns null if not authenticated.
 *
 * By default, sandbox JWT tokens are rejected. Pass `options.requiredCapability`
 * to accept sandbox tokens that include the specified capability, or
 * `options.acceptAnySandboxCapability` to accept tokens with any capability.
 */
export async function getAuthContext(
  authHeader?: string,
  options?: {
    requiredCapability?: Capability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<AuthContext | null> {
  // Session auth via Clerk
  const { userId } = await auth();
  if (userId) {
    return { userId };
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  if (isSandboxToken(token)) {
    // Without any sandbox opt-in, reject sandbox tokens (existing behavior)
    if (!options?.requiredCapability && !options?.acceptAnySandboxCapability) {
      log.debug("Rejected sandbox JWT token on normal API endpoint");
      return null;
    }

    // Verify sandbox token signature and expiry
    const sandboxAuth = verifySandboxToken(token);
    if (!sandboxAuth) {
      log.debug("Invalid or expired sandbox token");
      return null;
    }

    // acceptAnySandboxCapability: accept if token has any capability
    if (options?.acceptAnySandboxCapability) {
      if (!sandboxAuth.capabilities || sandboxAuth.capabilities.length === 0) {
        log.debug("Sandbox token has no capabilities");
        return null;
      }
      return {
        userId: sandboxAuth.userId,
        runId: sandboxAuth.runId,
        capabilities: [...sandboxAuth.capabilities],
      };
    }

    // requiredCapability: check specific capability
    const hasCap = sandboxAuth.capabilities?.some(
      (cap) => cap === options.requiredCapability,
    );
    if (!hasCap) {
      log.debug(
        `Sandbox token missing required capability: ${options.requiredCapability}`,
      );
      return null;
    }

    return {
      userId: sandboxAuth.userId,
      runId: sandboxAuth.runId,
      capabilities: sandboxAuth.capabilities
        ? [...sandboxAuth.capabilities]
        : undefined,
    };
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

  return {
    userId: tokenRecord.userId,
  };
}

/**
 * Get the current user ID from CLI token or Clerk session.
 * Returns null if not authenticated.
 */
export async function getUserId(
  authHeader?: string,
  options?: {
    requiredCapability?: Capability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<string | null> {
  const ctx = await getAuthContext(authHeader, options);
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
