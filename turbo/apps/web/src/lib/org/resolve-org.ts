import { auth } from "@clerk/nextjs/server";
import {
  forbidden,
  badRequest,
  isBadRequest,
  notFound,
  isNotFound,
  isForbidden,
} from "../errors";
import { getOrgBySlug, getOrgData } from "./org-cache-service";
import { verifyMembershipCached } from "./org-membership-cache";

import type { OrgRole } from "@vm0/core";

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
 * Requires explicit org context — either an orgSlug (?org= query param),
 * an explicit orgId, or a JWT session with active org. Does NOT guess
 * the user's org from cache or Clerk API.
 *
 * Resolution order:
 * 1. orgSlug (?org=<slug> query param) -> org_cache lookup, verify membership
 * 2. orgId (explicit param or JWT session) -> org_cache lookup, verify membership
 *
 * When the resolved org matches the JWT's active org, `tier` is read from
 * sessionClaims.org_tier (falling back to org_cache value if missing).
 *
 * @throws BadRequestError when no explicit org context is available
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

  // 2. Explicit orgId — use provided value or auto-detect from JWT.
  const effectiveOrgId = orgId ?? authResult.orgId ?? null;
  if (effectiveOrgId) {
    const orgData = await getOrgData(effectiveOrgId);
    const member = await verifyMembership(orgData, userId, authResult);
    return { org: applyJwtTier(orgData, authResult), member };
  }

  // No explicit org context available — require callers to provide one
  throw badRequest(
    "Explicit org context required — pass ?org= query parameter or ensure active org in session",
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
  userId: string,
  orgSlug?: string | null,
): Promise<ResolvedOrg | null> {
  try {
    const { org } = await resolveOrg(userId, orgSlug);
    return org;
  } catch (error) {
    if (isNotFound(error) || isBadRequest(error)) return null;
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
