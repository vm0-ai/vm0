import { auth } from "@clerk/nextjs/server";
import { forbidden, badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { getOrgBySlug, getOrgData } from "./org-cache-service";
import { getDefaultOrg } from "./org-member-service";
import { verifyMembershipCached } from "./org-membership-cache";

import type { OrgRole } from "@vm0/core";

const log = logger("org:resolve");

/**
 * Wrapper around getOrgData that returns null instead of throwing when the
 * org cannot be resolved.
 *
 * getOrgData throws when Clerk's getOrganization rejects (org not found)
 * or the fetched org has no slug.  Both are "not-found" semantics that
 * callers treat as a null result.  Database errors are unlikely to surface
 * here because getOrgBySlug (called first in the resolution chain) hits the
 * same DB — if the database were down, it would fail there first.
 */
export async function getOrgDataOrNull(
  orgId: string,
): Promise<{ orgId: string; slug: string; tier: string } | null> {
  try {
    return await getOrgData(orgId);
  } catch {
    return null;
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
export type ResolvedMember = {
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
 * 2. orgId (from JWT session token) -> org_cache lookup
 * 3. Fallback -> user's default org via Clerk API
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
      // Re-throw forbidden errors (user is not a member)
      if (error instanceof Error && error.message.includes("not a member")) {
        throw error;
      }
      // Org not found in Clerk — fall through to default org
      log.debug("orgId lookup failed, falling through to default", {
        orgId: effectiveOrgId,
      });
    }
  }

  // 3. Default org fallback
  return getDefaultOrg(userId);
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
