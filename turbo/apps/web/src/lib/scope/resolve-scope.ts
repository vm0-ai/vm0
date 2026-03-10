import { auth, clerkClient } from "@clerk/nextjs/server";
import { forbidden, badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { getScopeBySlug, getScopeByClerkOrgId } from "./scope-service";
import { getDefaultScope } from "./scope-member-service";

import type { ScopeRole } from "@vm0/core";
import type { scopes } from "../../db/schema/scope";

const log = logger("scope:resolve");

type Scope = typeof scopes.$inferSelect;

/**
 * Minimal member object returned by scope resolution.
 * Contains only the fields used downstream (primarily `role` for permission checks).
 */
type ResolvedMember = {
  role: ScopeRole;
  userId: string;
  scopeId: string;
};

/**
 * Verify a user's membership in a Clerk organization.
 * Returns the user's role, or throws 403 if not a member.
 *
 * Scopes with sentinel "pending_*" clerkOrgId cannot be verified — throws 403.
 */
async function verifyClerkMembership(
  scope: Scope,
  userId: string,
): Promise<ResolvedMember> {
  if (scope.clerkOrgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this scope");
  }

  try {
    const client = await clerkClient();
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: scope.clerkOrgId,
      });

    const membership = memberships.data.find(
      (m) => m.publicUserData?.userId === userId,
    );
    if (!membership) {
      throw forbidden("You are not a member of this scope");
    }

    const role: ScopeRole =
      membership.role === "org:admin" ? "admin" : "member";
    return { role, userId, scopeId: scope.id };
  } catch (error) {
    // Re-throw our own forbidden errors
    if (error instanceof Error && error.message.includes("not a member")) {
      throw error;
    }
    // Clerk API failure — deny access (security-first)
    log.error("verifyClerkMembership failed", {
      scopeId: scope.id,
      userId,
      clerkOrgId: scope.clerkOrgId,
      error,
    });
    throw forbidden("You are not a member of this scope");
  }
}

/**
 * Override scope.tier with JWT session claim when the resolved org matches
 * the JWT's active org. Falls back to DB tier if claim is missing.
 */
function applyJwtTier(
  scope: Scope,
  authResult: Awaited<ReturnType<typeof auth>>,
): Scope {
  if (
    scope.clerkOrgId === authResult.orgId &&
    authResult.sessionClaims?.org_tier
  ) {
    return { ...scope, tier: authResult.sessionClaims.org_tier };
  }
  return scope;
}

/**
 * Resolve scope from request context using Clerk API for membership verification.
 *
 * Resolution order:
 * 1. scopeSlug (?scope=<slug> query param) -> look up scope, verify Clerk membership
 * 2. clerkOrgId (from Clerk session token) -> look up scope by org ID, verify membership
 *    - Falls through to default if no matching scope exists yet
 * 3. Fallback -> user's default scope via Clerk API getOrganizationMembershipList
 *
 * When the resolved org matches the JWT's active org, `tier` is read from
 * sessionClaims.org_tier (falling back to DB value if missing).
 *
 * Returns { scope, member } for the resolved scope.
 */
export async function resolveScope(
  userId: string,
  scopeSlug?: string | null,
  clerkOrgId?: string | null,
) {
  const authResult = await auth();

  // 1. Explicit scope selection via ?scope= query param (highest priority)
  if (scopeSlug) {
    const scope = await getScopeBySlug(scopeSlug);
    if (!scope) throw notFound("Scope not found");

    const member = await verifyClerkMembership(scope, userId);
    return { scope: applyJwtTier(scope, authResult), member };
  }

  // 2. Clerk org ID — use provided value or auto-detect from session token.
  // For CLI tokens, auth().orgId returns null (no Clerk session),
  // so this tier is skipped and we fall through to the default scope.
  const effectiveOrgId = clerkOrgId ?? authResult.orgId ?? null;
  if (effectiveOrgId) {
    const scope = await getScopeByClerkOrgId(effectiveOrgId);
    if (scope) {
      const member = await verifyClerkMembership(scope, userId);
      return { scope: applyJwtTier(scope, authResult), member };
    }
    // Scope not found for this clerkOrgId — fall through to default
    // (scope may not be created yet in the migration period)
  }

  // 3. Default scope fallback (uses Clerk API to find user's orgs)
  return getDefaultScope(userId);
}

/**
 * Extract and validate scope from a request's ?scope= query parameter.
 * Throws if the scope param is missing, the scope doesn't exist, or the user
 * is not a member.
 *
 * Use this in org routes that always require an explicit scope parameter.
 */
export async function requireScopeFromRequest(
  request: Request,
  userId: string,
) {
  const url = new URL(request.url);
  const scopeSlug = url.searchParams.get("scope");
  if (!scopeSlug) {
    throw badRequest("scope query parameter is required");
  }
  const scope = await getScopeBySlug(scopeSlug);
  if (!scope) {
    throw notFound("Scope not found");
  }

  const authResult = await auth();
  const member = await verifyClerkMembership(scope, userId);
  return { scope: applyJwtTier(scope, authResult), member };
}
