import { auth, clerkClient } from "@clerk/nextjs/server";
import { forbidden, badRequest, notFound } from "../errors";
import { logger } from "../logger";
import {
  getScopeBySlug,
  getScopeByClerkOrgId,
  getScopeById,
} from "./scope-service";
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

/** Map Clerk org role string to our ScopeRole type. */
function mapOrgRole(clerkRole: string | undefined | null): ScopeRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Verify a user's membership in a Clerk organization.
 *
 * Fast path: if the scope's clerkOrgId matches the JWT's active org,
 * trust the JWT claims and skip the Clerk API call entirely.
 *
 * Slow path: for cross-org access (e.g. ?scope= pointing to a non-active org),
 * fall back to Clerk Backend API.
 *
 * CLI token path: if tokenScopeId is provided and matches the scope,
 * trust the token (membership was verified at token creation time).
 */
async function verifyMembership(
  scope: Scope,
  userId: string,
  authResult: Awaited<ReturnType<typeof auth>>,
  tokenScopeId?: string | null,
): Promise<ResolvedMember> {
  // CLI token with stored scope_id — trust if it matches
  if (tokenScopeId && scope.id === tokenScopeId) {
    return { role: "admin", userId, scopeId: scope.id };
  }

  // JWT fast path: active org matches → trust JWT, no API call
  if (scope.clerkOrgId === authResult.orgId) {
    return {
      role: mapOrgRole(authResult.orgRole),
      userId,
      scopeId: scope.id,
    };
  }

  if (scope.clerkOrgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this scope");
  }

  // Slow path: cross-org access → Clerk Backend API
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

    return {
      role: mapOrgRole(membership.role),
      userId,
      scopeId: scope.id,
    };
  } catch (error) {
    // Re-throw our own forbidden errors
    if (error instanceof Error && error.message.includes("not a member")) {
      throw error;
    }
    // Clerk API failure — deny access (security-first)
    log.error("verifyMembership failed", {
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
 * Resolve scope from request context.
 *
 * Uses JWT claims for membership verification when possible (zero Clerk API calls).
 * Falls back to Clerk Backend API for cross-org access or CLI tokens without scope_id.
 *
 * Resolution order:
 * 1. tokenScopeId (from CLI token) -> direct scope lookup, trusted
 * 2. scopeSlug (?scope=<slug> query param) -> look up scope, verify membership
 * 3. clerkOrgId (from JWT session token) -> look up scope by org ID
 * 4. Fallback -> user's default scope
 *
 * When the resolved org matches the JWT's active org, `tier` is read from
 * sessionClaims.org_tier (falling back to DB value if missing).
 */
export async function resolveScope(
  userId: string,
  scopeSlug?: string | null,
  clerkOrgId?: string | null,
  tokenScopeId?: string | null,
) {
  const authResult = await auth();

  // 1. Explicit scope selection via ?scope= query param (highest priority)
  if (scopeSlug) {
    const scope = await getScopeBySlug(scopeSlug);
    if (!scope) throw notFound("Scope not found");

    const member = await verifyMembership(
      scope,
      userId,
      authResult,
      tokenScopeId,
    );
    return { scope: applyJwtTier(scope, authResult), member };
  }

  // 2. CLI token with scope_id — direct lookup, no Clerk API needed
  if (tokenScopeId) {
    const scope = await getScopeById(tokenScopeId);
    if (scope) {
      return {
        scope: applyJwtTier(scope, authResult),
        member: { role: "admin" as ScopeRole, userId, scopeId: scope.id },
      };
    }
  }

  // 3. Clerk org ID — use provided value or auto-detect from JWT session token.
  // For CLI tokens, auth().orgId returns null (no Clerk session),
  // so this tier is skipped and we fall through to the default scope.
  const effectiveOrgId = clerkOrgId ?? authResult.orgId ?? null;
  if (effectiveOrgId) {
    const scope = await getScopeByClerkOrgId(effectiveOrgId);
    if (scope) {
      const member = await verifyMembership(
        scope,
        userId,
        authResult,
        tokenScopeId,
      );
      return { scope: applyJwtTier(scope, authResult), member };
    }
    // Scope not found for this clerkOrgId — fall through to default
    // (scope may not be created yet in the migration period)
  }

  // 4. Default scope fallback
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
  tokenScopeId?: string | null,
) {
  const url = new URL(request.url);
  const scopeSlug = url.searchParams.get("scope");
  const orgParam = url.searchParams.get("org");

  let scope: Scope | null = null;

  if (scopeSlug) {
    scope = await getScopeBySlug(scopeSlug);
  } else if (orgParam) {
    scope = await getScopeByClerkOrgId(orgParam);
  } else {
    throw badRequest("scope or org query parameter is required");
  }

  if (!scope) {
    throw notFound("Scope not found");
  }

  const authResult = await auth();
  const member = await verifyMembership(
    scope,
    userId,
    authResult,
    tokenScopeId,
  );
  return { scope: applyJwtTier(scope, authResult), member };
}
