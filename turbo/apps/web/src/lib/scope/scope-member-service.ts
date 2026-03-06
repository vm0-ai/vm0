import { eq, and, asc } from "drizzle-orm";
import { scopeMembers } from "../../db/schema/scope-member";
import { scopes } from "../../db/schema/scope";
import { forbidden, notFound } from "../errors";
import type { ScopeRole } from "@vm0/core";

/**
 * Get a scope member record for a specific user in a scope
 */
export async function getScopeMember(scopeId: string, userId: string) {
  const result = await globalThis.services.db
    .select()
    .from(scopeMembers)
    .where(
      and(eq(scopeMembers.scopeId, scopeId), eq(scopeMembers.userId, userId)),
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Require a user to be a member of a scope, or throw 403.
 * Returns the member record with role typed as ScopeRole.
 */
export async function requireScopeMember(scopeId: string, userId: string) {
  const member = await getScopeMember(scopeId, userId);
  if (!member) {
    throw forbidden("You are not a member of this scope");
  }
  return { ...member, role: member.role as ScopeRole };
}

/**
 * Find the user's primary admin membership (first admin membership by creation date).
 * Returns the raw scope_members record, or null if none found.
 */
export async function getPrimaryAdminMembership(userId: string) {
  const [record] = await globalThis.services.db
    .select()
    .from(scopeMembers)
    .where(and(eq(scopeMembers.userId, userId), eq(scopeMembers.role, "admin")))
    .orderBy(asc(scopeMembers.createdAt))
    .limit(1);
  return record ?? null;
}

/**
 * Get user's default scope (first owned scope from scope_members)
 * Falls back to legacy getUserScopeByClerkId behavior for backward compat
 */
export async function getDefaultScope(userId: string) {
  // Find first scope where user is admin (scope creator)
  const result = await globalThis.services.db
    .select({
      scope: scopes,
      member: scopeMembers,
    })
    .from(scopeMembers)
    .innerJoin(scopes, eq(scopeMembers.scopeId, scopes.id))
    .where(and(eq(scopeMembers.userId, userId), eq(scopeMembers.role, "admin")))
    .orderBy(asc(scopeMembers.createdAt))
    .limit(1);

  if (result[0]) {
    return result[0];
  }

  // Fallback: find any scope the user is a member of
  const anyMembership = await globalThis.services.db
    .select({
      scope: scopes,
      member: scopeMembers,
    })
    .from(scopeMembers)
    .innerJoin(scopes, eq(scopeMembers.scopeId, scopes.id))
    .where(eq(scopeMembers.userId, userId))
    .orderBy(asc(scopeMembers.createdAt))
    .limit(1);

  if (anyMembership[0]) {
    return anyMembership[0];
  }

  throw notFound("No scope found for user");
}
