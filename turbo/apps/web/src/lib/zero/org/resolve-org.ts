import { eq } from "drizzle-orm";
import {
  forbidden,
  notFound,
  badRequest,
  isBadRequest,
  isNotFound,
} from "../../errors";
import { getOrgData } from "./org-cache-service";
import { getOrgMetadata } from "./org-metadata-service";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { orgCache } from "../../../db/schema/org-cache";
import { verifyMembershipCached } from "./org-membership-cache";
import type { AuthContext } from "../../auth/get-auth-context";

import type { OrgRole } from "@vm0/core";

/**
 * Returns true when the error represents a "resource not found" condition
 * that should be treated as null rather than re-thrown.
 *
 * Covers:
 * - Our own NotFoundError (from errors.ts)
 * - Clerk API 404 responses (ClerkAPIResponseError with status 404)
 * - Missing-slug guard ("has no slug")
 */
function isOrgNotFoundError(error: unknown): boolean {
  if (isNotFound(error)) return true;
  if (error instanceof Error) {
    // Clerk API 404 responses (ClerkAPIResponseError with numeric status)
    const statusHolder = error as { status?: unknown };
    if (statusHolder.status === 404) return true;
    // Clerk SDK org-not-found rejections: "Organization <id> not found"
    // Also covers missing-slug guard: "Clerk organization <id> has no slug"
    if (/organization\b.*\b(not found|has no slug)/i.test(error.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Wrapper around getOrgMetadata that returns null instead of throwing when the
 * org cannot be resolved.
 *
 * Only swallows not-found errors (our NotFoundError, Clerk API 404,
 * missing slug). Unexpected errors (DB failures, timeouts) propagate.
 */
export async function getOrgDataOrNull(
  orgId: string,
): Promise<{ orgId: string; tier: string } | null> {
  try {
    return await getOrgMetadata(orgId);
  } catch (error) {
    if (isOrgNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Lightweight org type based on org_metadata data.
 * Contains only orgId and tier — no Clerk-derived fields (slug, name).
 */
export interface ResolvedOrg {
  orgId: string;
  tier: string;
}

/**
 * Minimal member object returned by org resolution.
 * Contains only the fields used downstream (primarily `role` for permission checks).
 */
type ResolvedMember = {
  role: OrgRole;
  userId: string;
};

/**
 * Verify a user's membership in a Clerk organization.
 *
 * Fast path: if the org's orgId matches the AuthContext's active org,
 * trust the JWT claims and skip the Clerk API call entirely.
 *
 * Cache path: for CLI tokens or cross-org access, use org_members_cache
 * with Clerk API fallback (1-minute TTL).
 */
async function verifyMembership(
  resolved: ResolvedOrg,
  authCtx: AuthContext,
): Promise<ResolvedMember> {
  // JWT fast path: active org matches → trust JWT, no API call
  if (resolved.orgId === authCtx.orgId) {
    return {
      role: authCtx.orgRole ?? "member",
      userId: authCtx.userId,
    };
  }

  if (resolved.orgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this organization");
  }

  // Cache-backed path: check org_members_cache, fall back to Clerk API
  const result = await verifyMembershipCached(resolved.orgId, authCtx.userId);
  if (!result) {
    throw forbidden("You are not a member of this organization");
  }
  return { role: result.role, userId: authCtx.userId };
}

/**
 * Resolve org from request context using org_cache + org table.
 *
 * Requires explicit org context — either an explicit orgId or an
 * AuthContext with active org. Does NOT guess the user's org from
 * cache or Clerk API.
 *
 * Tier is always read from the org table (source of truth).
 *
 * @throws BadRequestError when no explicit org context is available
 */
export async function resolveOrg(
  authCtx: AuthContext,
  orgId?: string | null,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const effectiveOrgId = orgId ?? authCtx.orgId ?? null;
  if (effectiveOrgId) {
    // Verify org is known to the system.
    // Check org_metadata first (platform-owned), then org_cache (Clerk-validated).
    // getOrgMetadata returns defaults for missing rows, so we need an explicit check.
    const db = globalThis.services.db;
    const [metaRow] = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, effectiveOrgId))
      .limit(1);
    if (!metaRow) {
      const [cacheRow] = await db
        .select({ orgId: orgCache.orgId })
        .from(orgCache)
        .where(eq(orgCache.orgId, effectiveOrgId))
        .limit(1);
      if (!cacheRow) {
        // Cold start: org not in our DB yet (e.g. new signup).
        // Fall back to Clerk API to validate and populate org_cache.
        try {
          await getOrgData(effectiveOrgId);
        } catch (error) {
          if (isOrgNotFoundError(error)) {
            throw notFound(`Organization ${effectiveOrgId} not found`);
          }
          throw error;
        }
      }
    }

    const orgMeta = await getOrgMetadata(effectiveOrgId);
    const resolved: ResolvedOrg = { orgId: orgMeta.orgId, tier: orgMeta.tier };
    const member = await verifyMembership(resolved, authCtx);
    return { org: resolved, member };
  }

  throw badRequest(
    "Explicit org context required — ensure active org in session",
  );
}

/**
 * Null-safe org resolution. Returns null if no org found or no explicit
 * org context available, instead of throwing.
 *
 * Used by handlers that operate outside request context
 * (Slack, Telegram, email) where missing org is expected.
 */
export async function resolveOrgOrNull(
  authCtx: AuthContext,
): Promise<ResolvedOrg | null> {
  try {
    const { org } = await resolveOrg(authCtx);
    return org;
  } catch (error) {
    if (isNotFound(error) || isBadRequest(error)) return null;
    throw error;
  }
}
