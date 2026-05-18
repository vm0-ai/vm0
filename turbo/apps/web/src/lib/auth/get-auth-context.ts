import { eq, and, gt } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import {
  isSandboxToken,
  isPatToken,
  verifySandboxToken,
  verifyZeroToken,
  verifyCliToken,
} from "./sandbox-token";
import { getMemberRole } from "./org-membership-cache";
import { logger } from "../shared/logger";
import { hasRequiredCapability } from "./capability-check";

const log = logger("auth:user");

export type AuthTokenType = "session" | "pat" | "sandbox" | "zero";

/**
 * Clerk session JWT claims. Fields declared here are the ones we project into
 * user info via `userProfileFromClaims`. The index signature preserves Clerk's
 * built-in claims (`sub`, `org_id`, `org_role`, etc.) and any unknown custom
 * claims without forcing us to enumerate them.
 */
export interface SessionClaims {
  email?: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
}

/**
 * Authentication context returned by getAuthContext.
 */
export type AuthContext = {
  userId: string;
  orgId?: string;
  orgRole?: OrgRole;
  sessionClaims?: SessionClaims;
  capabilities?: readonly ZeroCapability[];
  runId?: string;
  tokenType?: AuthTokenType;
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
    requiredCapability?: ZeroCapability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<AuthContext | null> {
  // Check Bearer token prefixes first (fast, no external calls)
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7); // Remove "Bearer "

    // Check for PAT token (vm0_pat_ prefix — CLI personal access tokens)
    if (isPatToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (cliAuth) {
        const resolved = await resolveCliTokenFromDb(cliAuth);
        if (!resolved) return null;
        if (resolved.orgId) {
          const membership = await getMemberRole(
            resolved.orgId,
            resolved.userId,
          );
          if (!membership) {
            // User no longer a member — omit orgId to force resolveOrg rejection
            return { userId: resolved.userId, tokenType: "pat" };
          }
          return {
            userId: resolved.userId,
            orgId: resolved.orgId,
            orgRole: membership.role,
            tokenType: "pat",
          };
        }
        return {
          userId: resolved.userId,
          orgId: resolved.orgId,
          tokenType: "pat",
        };
      }
      return null;
    }

    if (isSandboxToken(token)) {
      return authenticateSandboxToken(token, options);
    }
    // Unknown Bearer shape (e.g. a Clerk session JWT forwarded by the
    // platform api-client) — fall through to Clerk session auth below.
    // clerkMiddleware populates `auth()` from the Authorization header
    // itself, so we defer the decision to it rather than 401'ing here.
  }

  return getClerkSessionAuth();
}

/** Authenticate a sandbox-prefixed token (sandbox or zero scope). */
async function authenticateSandboxToken(
  token: string,
  options?: {
    requiredCapability?: ZeroCapability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<AuthContext | null> {
  // Without any sandbox opt-in, reject sandbox tokens (existing behavior)
  if (!options?.requiredCapability && !options?.acceptAnySandboxCapability) {
    log.debug("Rejected sandbox JWT token on normal API endpoint");
    return null;
  }

  // Try sandbox token first
  const sandboxAuth = verifySandboxToken(token);
  if (sandboxAuth) {
    return resolveSandboxAuth(sandboxAuth, options);
  }

  // Try zero token (scope: "zero")
  const zeroAuth = verifyZeroToken(token);
  if (zeroAuth) {
    const result = resolveZeroAuth(zeroAuth, options);
    if (result && result.orgId) {
      const membership = await getMemberRole(result.orgId, result.userId);
      if (!membership) {
        // User no longer a member — omit orgId (same pattern as CLI JWT path)
        return { userId: result.userId, runId: result.runId };
      }
      return { ...result, orgRole: membership.role };
    }
    return result;
  }

  log.debug("Invalid or expired sandbox/zero token");
  return null;
}

function resolveSandboxAuth(
  sandboxAuth: {
    userId: string;
    orgId: string;
    runId: string;
  },
  options: {
    requiredCapability?: ZeroCapability;
    acceptAnySandboxCapability?: boolean;
  },
): AuthContext | null {
  if (options.acceptAnySandboxCapability) {
    return {
      userId: sandboxAuth.userId,
      orgId: sandboxAuth.orgId,
      runId: sandboxAuth.runId,
      tokenType: "sandbox",
    };
  }

  // Sandbox tokens no longer carry capabilities — requiredCapability
  // checks always fail. Zero routes should use ZERO_TOKEN instead.
  log.debug(
    `Sandbox token cannot satisfy required capability: ${options.requiredCapability}`,
  );
  return null;
}

function resolveZeroAuth(
  zeroAuth: {
    userId: string;
    runId: string;
    orgId: string;
    capabilities: readonly ZeroCapability[];
  },
  options: {
    requiredCapability?: ZeroCapability;
    acceptAnySandboxCapability?: boolean;
  },
): AuthContext | null {
  if (options.acceptAnySandboxCapability) {
    return {
      userId: zeroAuth.userId,
      runId: zeroAuth.runId,
      orgId: zeroAuth.orgId,
      capabilities: [...zeroAuth.capabilities],
      tokenType: "zero",
    };
  }

  if (
    !hasRequiredCapability(zeroAuth.capabilities, options.requiredCapability)
  ) {
    log.debug(
      `Zero token missing required capability: ${options.requiredCapability}`,
    );
    return null;
  }

  return {
    userId: zeroAuth.userId,
    runId: zeroAuth.runId,
    orgId: zeroAuth.orgId,
    capabilities: [...zeroAuth.capabilities],
    tokenType: "zero",
  };
}

/**
 * Resolve CLI JWT auth by checking DB revocation and updating lastUsedAt.
 * Shared by getAuthContext and getRunnerAuth to avoid duplicating the
 * DB lookup + expiry check + lastUsedAt update logic.
 *
 * Returns { userId, orgId } on success, or null if the token is revoked/expired.
 */
export async function resolveCliTokenFromDb(cliAuth: {
  userId: string;
  orgId: string;
  tokenId: string;
}): Promise<{ userId: string; orgId: string } | null> {
  const [record] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(
      and(
        eq(cliTokens.id, cliAuth.tokenId),
        gt(cliTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!record) {
    log.debug("CLI JWT token revoked or expired in DB");
    return null;
  }

  // Update last used timestamp (non-blocking)
  globalThis.services.db
    .update(cliTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(cliTokens.id, cliAuth.tokenId))
    .catch((err) => {
      return log.error("Failed to update token lastUsedAt:", err);
    });

  return {
    userId: cliAuth.userId,
    orgId: cliAuth.orgId,
  };
}

/** Extract AuthContext from Clerk session, or null if not authenticated. */
async function getClerkSessionAuth(): Promise<AuthContext | null> {
  const authResult = await auth();
  if (!authResult.userId) return null;

  return {
    userId: authResult.userId,
    orgId: authResult.orgId ?? undefined,
    orgRole: authResult.orgRole
      ? authResult.orgRole === "org:admin"
        ? "admin"
        : "member"
      : undefined,
    sessionClaims: authResult.sessionClaims as SessionClaims | undefined,
    tokenType: "session",
  };
}

/**
 * Get the current user ID from CLI token or Clerk session.
 * Returns null if not authenticated.
 */
export async function getUserId(
  authHeader?: string,
  options?: {
    requiredCapability?: ZeroCapability;
    acceptAnySandboxCapability?: boolean;
  },
): Promise<string | null> {
  const ctx = await getAuthContext(authHeader, options);
  return ctx?.userId ?? null;
}
