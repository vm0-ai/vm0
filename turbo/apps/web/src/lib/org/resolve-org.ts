import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq, desc } from "drizzle-orm";
import {
  forbidden,
  badRequest,
  notFound,
  isNotFound,
  isForbidden,
} from "../errors";
import { logger } from "../logger";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { getOrgBySlug, getOrgData } from "./org-cache-service";
import { verifyMembershipCached } from "./org-membership-cache";

import type { OrgRole } from "@vm0/core";

const log = logger("org:resolve");

/**
 * Returns true when the error represents a "resource not found" condition
 * that should be treated as null rather than re-thrown.
 *
 * Covers:
 * - Our own NotFoundError (from errors.ts)
 * - Clerk API 404 responses (ClerkAPIResponseError with status 404)
 * - Missing-slug guard in getOrgData ("has no slug")
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
 * Wrapper around getOrgData that returns null instead of throwing when the
 * org cannot be resolved.
 *
 * Only swallows not-found errors (our NotFoundError, Clerk API 404,
 * missing slug). Unexpected errors (DB failures, timeouts) propagate.
 */
export async function getOrgDataOrNull(
  orgId: string,
): Promise<{ orgId: string; slug: string; tier: string } | null> {
  try {
    return await getOrgData(orgId);
  } catch (error) {
    if (isOrgNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Lightweight org type based on org_cache data.
 * Replaces the full org_cache.$inferSelect type for the resolution path.
 */
export interface ResolvedOrg {
  orgId: string;
  slug: string;
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

/** Map Clerk org role string to our OrgRole type. */
function mapOrgRole(clerkRole: string | undefined | null): OrgRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Verify a user's membership in a Clerk organization.
 *
 * Fast path: if the org's orgId matches the JWT's active org,
 * trust the JWT claims and skip the Clerk API call entirely.
 *
 * Cache path: for CLI tokens or cross-org access, use org_members_cache
 * with Clerk API fallback (1-minute TTL).
 */
async function verifyMembership(
  resolved: ResolvedOrg,
  userId: string,
  authResult: Awaited<ReturnType<typeof auth>>,
): Promise<ResolvedMember> {
  // JWT fast path: active org matches → trust JWT, no API call
  if (resolved.orgId === authResult.orgId) {
    return {
      role: mapOrgRole(authResult.orgRole),
      userId,
    };
  }

  if (resolved.orgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this organization");
  }

  // Cache-backed path: check org_members_cache, fall back to Clerk API
  const result = await verifyMembershipCached(resolved.orgId, userId);
  if (!result) {
    throw forbidden("You are not a member of this organization");
  }
  return { role: result.role, userId };
}

/**
 * Override org tier with JWT session claim when the resolved org matches
 * the JWT's active org. Falls back to org_cache tier if claim is missing.
 */
function applyJwtTier(
  resolved: ResolvedOrg,
  authResult: Awaited<ReturnType<typeof auth>>,
): ResolvedOrg {
  if (
    resolved.orgId === authResult.orgId &&
    authResult.sessionClaims?.org_tier
  ) {
    return { ...resolved, tier: authResult.sessionClaims.org_tier };
  }
  return resolved;
}

/**
 * Resolve org from request context using org_cache.
 *
 * Uses JWT claims for membership verification when possible (zero Clerk API calls).
 * Falls back to org_members_cache (with Clerk API fallback) for CLI tokens.
 *
 * Resolution order:
 * 1. orgSlug (?org=<slug> query param) -> org_cache lookup, verify membership
 * 2. orgId (from JWT session token) -> org_cache lookup, verify membership
 * 3. org_members_cache (1min TTL) -> org_cache lookup, verify membership
 * 4. Clerk API slow path (last resort) -> org_cache lookup
 *
 * When the resolved org matches the JWT's active org, `tier` is read from
 * sessionClaims.org_tier (falling back to org_cache value if missing).
 */
export async function resolveOrg(
  userId: string,
  orgSlug?: string | null,
  orgId?: string | null,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const authResult = await auth();

  // 1. Explicit org selection via ?org= query param (highest priority)
  if (orgSlug) {
    const orgData = await getOrgBySlug(orgSlug);
    if (!orgData) throw notFound("Org not found");

    const member = await verifyMembership(orgData, userId, authResult);
    return { org: applyJwtTier(orgData, authResult), member };
  }

  // 2. Clerk org ID — use provided value or auto-detect from JWT.
  // For CLI tokens (no Clerk session), auth().orgId returns null,
  // so this tier is skipped and we fall through to the default org.
  const effectiveOrgId = orgId ?? authResult.orgId ?? null;
  if (effectiveOrgId) {
    try {
      const orgData = await getOrgData(effectiveOrgId);
      const member = await verifyMembership(orgData, userId, authResult);
      return { org: applyJwtTier(orgData, authResult), member };
    } catch (error) {
      // Only fall through to tier 3/4 for not-found errors (org doesn't exist).
      // Re-throw everything else (forbidden, DB errors, timeouts).
      if (!isOrgNotFoundError(error)) {
        throw error;
      }
      log.debug("orgId lookup failed, falling through to default", {
        orgId: effectiveOrgId,
      });
    }
  }

  // 3. org_members_cache fallback (1min TTL)
  const [cached] = await globalThis.services.db
    .select()
    .from(orgMembersCache)
    .where(eq(orgMembersCache.userId, userId))
    .orderBy(desc(orgMembersCache.cachedAt))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < 60_000) {
    const orgData = await getOrgDataOrNull(cached.orgId);
    if (orgData) {
      const member = await verifyMembership(orgData, userId, authResult);
      return { org: applyJwtTier(orgData, authResult), member };
    }
  }

  // 4. Clerk API slow path (last resort)
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
  });

  // Priority: admin orgs first, then any org
  const adminMembership = memberships.data.find((m) => m.role === "org:admin");
  const candidates = adminMembership
    ? [
        adminMembership,
        ...memberships.data.filter((m) => m !== adminMembership),
      ]
    : memberships.data;

  for (const membership of candidates) {
    const mOrgId = membership.organization.id;
    const orgData = await getOrgDataOrNull(mOrgId);
    if (orgData) {
      return {
        org: applyJwtTier(orgData, authResult),
        member: {
          role: mapOrgRole(membership.role),
          userId,
        },
      };
    }
  }

  throw notFound("No org found for user");
}

/**
 * Null-safe org resolution. Returns null if no org found, instead of throwing.
 *
 * Used by handlers that operate outside request context
 * (Slack, Telegram, email) where missing org is expected.
 */
export async function resolveOrgOrNull(
  userId: string,
  orgSlug?: string | null,
): Promise<ResolvedOrg | null> {
  try {
    const { org } = await resolveOrg(userId, orgSlug);
    return org;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Resolve the caller's org ID from the request's ?org= query parameter.
 *
 * Returns null if the org cannot be resolved (not found, forbidden, or user
 * is not a member). Use this in endpoints that need to compare the caller's
 * org against a resource's org without leaking information about whether the
 * resource exists.
 */
export async function resolveCallerOrgId(
  userId: string,
  request: Request,
): Promise<string | null> {
  const orgSlug = new URL(request.url).searchParams.get("org");
  try {
    const { org } = await resolveOrg(userId, orgSlug);
    return org.orgId;
  } catch (error) {
    if (isNotFound(error) || isForbidden(error)) return null;
    throw error;
  }
}

/**
 * Extract and validate org from a request's ?org= query parameter.
 * Throws if the param is missing, the org doesn't exist, or the user
 * is not a member.
 *
 * Use this in org routes that always require an explicit org parameter.
 */
export async function requireOrgFromRequest(
  request: Request,
  userId: string,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("org");

  if (!orgSlug) {
    throw badRequest("org query parameter is required");
  }

  // Try slug first, fall back to orgId (callers may pass either via ?org=)
  const orgData =
    (await getOrgBySlug(orgSlug)) ?? (await getOrgDataOrNull(orgSlug));

  if (!orgData) {
    throw notFound("Org not found");
  }

  const authResult = await auth();
  const member = await verifyMembership(orgData, userId, authResult);
  return { org: applyJwtTier(orgData, authResult), member };
}
