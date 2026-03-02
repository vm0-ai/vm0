import { randomBytes } from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { orgAccessTokens } from "../../db/schema/org-access-token";
import { logger } from "../logger";
import type { OrgRole } from "@vm0/core";

const log = logger("service:org-token");

const ORG_TOKEN_PREFIX = "vm0_org_";
const ORG_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Generate a new org access token for a user+scope pair.
 * Deletes any existing token for the same user+scope before creating a new one.
 */
export async function generateOrgAccessToken(
  userId: string,
  scopeId: string,
  role: OrgRole,
): Promise<{ token: string; expiresAt: Date }> {
  // Delete existing tokens for this user+scope
  await globalThis.services.db
    .delete(orgAccessTokens)
    .where(
      and(
        eq(orgAccessTokens.userId, userId),
        eq(orgAccessTokens.scopeId, scopeId),
      ),
    );

  const token = `${ORG_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + ORG_TOKEN_TTL_MS);

  await globalThis.services.db.insert(orgAccessTokens).values({
    token,
    userId,
    scopeId,
    role,
    expiresAt,
  });

  log.debug("Generated org access token", { userId, scopeId, role });

  return { token, expiresAt };
}

/**
 * Resolve a vm0_org_* token to its associated user, scope, and role.
 * Returns null if the token is invalid or expired.
 * Updates lastUsedAt non-blocking (same pattern as cli_tokens).
 */
export async function resolveOrgAccessToken(
  token: string,
): Promise<{ userId: string; scopeId: string; role: OrgRole } | null> {
  const [record] = await globalThis.services.db
    .select()
    .from(orgAccessTokens)
    .where(
      and(
        eq(orgAccessTokens.token, token),
        gt(orgAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!record) {
    return null;
  }

  // Update last used timestamp (non-blocking, same pattern as cli_tokens)
  void globalThis.services.db
    .update(orgAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(orgAccessTokens.token, token))
    .catch((err) => log.error("Failed to update org token lastUsedAt:", err));

  return {
    userId: record.userId,
    scopeId: record.scopeId,
    role: record.role as OrgRole,
  };
}

/**
 * Revoke all org tokens for a specific user+scope pair.
 * Used when a member is removed or leaves an organization.
 */
export async function revokeOrgAccessTokens(
  userId: string,
  scopeId: string,
): Promise<void> {
  await globalThis.services.db
    .delete(orgAccessTokens)
    .where(
      and(
        eq(orgAccessTokens.userId, userId),
        eq(orgAccessTokens.scopeId, scopeId),
      ),
    );

  log.debug("Revoked org access tokens", { userId, scopeId });
}
