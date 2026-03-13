import { auth, clerkClient } from "@clerk/nextjs/server";
import { forbidden, badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { getOrgBySlug, getOrgData } from "./org-cache-service";
import { getDefaultOrg } from "./org-member-service";

import type { OrgRole } from "@vm0/core";

const log = logger("org:resolve");

/**
 * Lightweight org type based on org_cache data.
 * Replaces the full scopes.$inferSelect type for the resolution path.
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
 * Slow path: for cross-org access (e.g. ?scope= pointing to a non-active org),
 * fall back to Clerk Backend API.
 *
 * CLI token path: if tokenOrgId is provided and matches the org,
 * trust the token (membership was verified at token creation time).
 */
async function verifyMembership(
  resolved: ResolvedOrg,
  userId: string,
  authResult: Awaited<ReturnType<typeof auth>>,
  tokenOrgId?: string | null,
): Promise<ResolvedMember> {
  // CLI token with stored org_id — trust if it matches
  if (tokenOrgId && resolved.orgId === tokenOrgId) {
    return { role: "admin", userId };
  }

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

  // Slow path: cross-org access → Clerk Backend API
  try {
    const client = await clerkClient();
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: resolved.orgId,
      });

    const membership = memberships.data.find(
      (m) => m.publicUserData?.userId === userId,
    );
    if (!membership) {
      throw forbidden("You are not a member of this organization");
    }

    return {
      role: mapOrgRole(membership.role),
      userId,
    };
  } catch (error) {
    // Re-throw our own forbidden errors
    if (error instanceof Error && error.message.includes("not a member")) {
      throw error;
    }
    // Clerk API failure — deny access (security-first)
    log.error("verifyMembership failed", {
      userId,
      orgId: resolved.orgId,
      error,
    });
    throw forbidden("You are not a member of this organization");
  }
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
 * Resolve org from request context using org_cache (never queries scopes table).
 *
 * Uses JWT claims for membership verification when possible (zero Clerk API calls).
 * Falls back to Clerk Backend API for cross-org access or CLI tokens without org_id.
 *
 * Resolution order:
 * 1. orgSlug (?scope=<slug> query param) -> org_cache lookup, verify membership
 * 2. orgId (from JWT session token or CLI token) -> org_cache lookup
 * 3. Fallback -> user's default org via Clerk API
 *
 * When the resolved org matches the JWT's active org, `tier` is read from
 * sessionClaims.org_tier (falling back to org_cache value if missing).
 */
export async function resolveOrg(
  userId: string,
  orgSlug?: string | null,
  orgId?: string | null,
  tokenOrgId?: string | null,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const authResult = await auth();

  // 1. Explicit org selection via ?scope= query param (highest priority)
  if (orgSlug) {
    const orgData = await getOrgBySlug(orgSlug);
    if (!orgData) throw notFound("Org not found");

    const member = await verifyMembership(
      orgData,
      userId,
      authResult,
      tokenOrgId,
    );
    return { org: applyJwtTier(orgData, authResult), member };
  }

  // 2. Clerk org ID — use provided value, CLI token orgId, or auto-detect from JWT.
  // For CLI tokens without orgId, auth().orgId returns null (no Clerk session),
  // so this tier is skipped and we fall through to the default org.
  const effectiveOrgId = orgId ?? tokenOrgId ?? authResult.orgId ?? null;
  if (effectiveOrgId) {
    try {
      const orgData = await getOrgData(effectiveOrgId);
      const member = await verifyMembership(
        orgData,
        userId,
        authResult,
        tokenOrgId,
      );
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
 * Extract and validate org from a request's ?scope= or ?org= query parameter.
 * Throws if the param is missing, the org doesn't exist, or the user
 * is not a member.
 *
 * Use this in org routes that always require an explicit org parameter.
 */
export async function requireOrgFromRequest(
  request: Request,
  userId: string,
  tokenOrgId?: string | null,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const url = new URL(request.url);
  const orgSlug = url.searchParams.get("scope");
  const orgParam = url.searchParams.get("org");

  let orgData: ResolvedOrg | null = null;

  if (orgSlug) {
    orgData = await getOrgBySlug(orgSlug);
  } else if (orgParam) {
    try {
      orgData = await getOrgData(orgParam);
    } catch {
      orgData = null;
    }
  } else {
    throw badRequest("org query parameter is required");
  }

  if (!orgData) {
    throw notFound("Org not found");
  }

  const authResult = await auth();
  const member = await verifyMembership(
    orgData,
    userId,
    authResult,
    tokenOrgId,
  );
  return { org: applyJwtTier(orgData, authResult), member };
}
