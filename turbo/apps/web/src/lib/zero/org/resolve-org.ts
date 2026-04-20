import {
  forbidden,
  badRequest,
  isBadRequest,
  isNotFound,
} from "../../shared/errors";
import { getOrgMetadata } from "./org-metadata-service";
import type { OrgMetadata } from "./org-metadata-service";
import { getMemberRole } from "../../auth/org-membership-cache";
import type { AuthContext } from "../../auth/get-auth-context";

import type { OrgRole } from "@vm0/core";

/**
 * Lightweight org type based on org_metadata data.
 * Contains only orgId and tier — no Clerk-derived fields (slug, name).
 */
interface ResolvedOrg {
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
  const result = await getMemberRole(resolved.orgId, authCtx.userId);
  if (!result) {
    throw forbidden("You are not a member of this organization");
  }
  return { role: result.role, userId: authCtx.userId };
}

/**
 * Resolve org from request context using org_metadata table.
 *
 * Requires explicit org context from AuthContext (active org in session).
 * Tier is always read from the org table (source of truth).
 *
 * @throws BadRequestError when no explicit org context is available
 */
export async function resolveOrg(
  authCtx: AuthContext,
): Promise<{ org: ResolvedOrg; member: ResolvedMember }> {
  const orgId = authCtx.orgId ?? null;
  if (!orgId) {
    throw badRequest(
      "Explicit org context required — ensure active org in session",
    );
  }

  let orgMeta: OrgMetadata;
  try {
    orgMeta = await getOrgMetadata(orgId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // Brand-new org: JWT proves existence, org_metadata row not yet created
    orgMeta = { orgId, tier: "free", credits: 0 };
  }
  const resolved: ResolvedOrg = { orgId: orgMeta.orgId, tier: orgMeta.tier };
  const member = await verifyMembership(resolved, authCtx);
  return { org: resolved, member };
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
