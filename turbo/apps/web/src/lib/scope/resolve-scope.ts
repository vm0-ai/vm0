import { clerkClient } from "@clerk/nextjs/server";
import { scopeMembers } from "../../db/schema/scope-member";
import { hasClerkAuth } from "../../env";
import { isForbidden, badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { scopeRoleSchema } from "@vm0/core";
import { getScopeBySlug, getScopeByClerkOrgId } from "./scope-service";
import {
  requireScopeMember,
  getDefaultScope,
  getScopeMember,
} from "./scope-member-service";

import type { scopes } from "../../db/schema/scope";

const log = logger("scope:resolve");

type Scope = typeof scopes.$inferSelect;

/**
 * Verify a user's Clerk org membership and lazily create a scope_members record.
 *
 * Only attempts sync when:
 * - Clerk auth is configured
 * - The scope has a real Clerk org ID (not a sentinel like "pending_*" or "org_self_hosted")
 *
 * Returns the new scope member record, or null if the user is not a Clerk member.
 */
async function syncClerkMembership(scope: Scope, userId: string) {
  if (
    !hasClerkAuth() ||
    scope.clerkOrgId.startsWith("pending_") ||
    scope.clerkOrgId === "org_self_hosted"
  ) {
    return null;
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
    if (!membership) return null;

    const role = membership.role === "org:admin" ? "admin" : "member";

    // Create scope_members record
    const [member] = await globalThis.services.db
      .insert(scopeMembers)
      .values({ scopeId: scope.id, userId, role })
      .onConflictDoNothing()
      .returning();

    // If onConflictDoNothing returned nothing, the record was created by another concurrent request
    const record = member ?? (await getScopeMember(scope.id, userId));
    if (!record) return null;
    return { ...record, role: scopeRoleSchema.parse(record.role) };
  } catch (error) {
    // Intentional exception to fail-fast principle: when Clerk is unavailable,
    // deny access (return null -> 403) rather than crashing the request.
    // This is a security-first choice — external service failure should not
    // grant access. The error is logged for observability.
    log.error("syncClerkMembership failed", {
      scopeId: scope.id,
      userId,
      clerkOrgId: scope.clerkOrgId,
      error,
    });
    return null;
  }
}

/**
 * Verify scope membership with Clerk org sync fallback.
 *
 * Checks scope_members first. If the user is not found and the scope has a
 * Clerk org, attempts to lazily sync membership from Clerk.
 */
async function requireMemberWithClerkSync(scope: Scope, userId: string) {
  try {
    return await requireScopeMember(scope.id, userId);
  } catch (error) {
    if (!isForbidden(error) || !scope.clerkOrgId) throw error;

    // User not in scope_members — check Clerk org membership
    const member = await syncClerkMembership(scope, userId);
    if (!member) throw error; // Not a Clerk member either
    return member;
  }
}

/**
 * Resolve scope from request context using scope_members.
 *
 * Resolution order:
 * 1. scopeSlug (?scope=<slug> query param) -> look up scope, verify membership
 *    - If not in scope_members, try to sync from Clerk org membership
 * 2. clerkOrgId (from Clerk session token) -> look up scope by org ID
 *    - Falls through to default if no matching scope exists yet
 * 3. Fallback -> user's default scope (first owned scope from scope_members)
 *
 * Returns { scope, member } for the resolved scope.
 */
export async function resolveScope(
  userId: string,
  scopeSlug?: string | null,
  clerkOrgId?: string | null,
) {
  // 1. Explicit scope selection via ?scope= query param (highest priority)
  if (scopeSlug) {
    const scope = await getScopeBySlug(scopeSlug);
    if (!scope) throw notFound("Scope not found");

    const member = await requireMemberWithClerkSync(scope, userId);
    return { scope, member };
  }

  // 2. Clerk org ID from session token
  if (clerkOrgId) {
    const scope = await getScopeByClerkOrgId(clerkOrgId);
    if (scope) {
      const member = await requireMemberWithClerkSync(scope, userId);
      return { scope, member };
    }
    // Scope not found for this clerkOrgId — fall through to default
    // (scope may not be created yet in the migration period)
  }

  // 3. Default scope fallback
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

  const member = await requireMemberWithClerkSync(scope, userId);
  return { scope, member };
}
