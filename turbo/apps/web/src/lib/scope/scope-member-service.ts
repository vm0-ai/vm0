import { eq, and, asc } from "drizzle-orm";
import { scopeMembers } from "../../db/schema/scope-member";
import { scopes } from "../../db/schema/scope";
import { forbidden, notFound } from "../errors";
import type { OrgRole } from "@vm0/core";

/**
 * Get a scope member record for a specific user in a scope
 */
async function getScopeMember(scopeId: string, userId: string) {
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
 * Require a user to be a member of a scope, or throw 403
 */
export async function requireScopeMember(scopeId: string, userId: string) {
  const member = await getScopeMember(scopeId, userId);
  if (!member) {
    throw forbidden("You are not a member of this scope");
  }
  return member;
}

/**
 * Ensure a scope_members record exists for the given user+scope.
 * Lazy-creates the record if missing (org token was generated after Clerk
 * verification, so the user is a verified member).
 */
export async function ensureScopeMember(
  scopeId: string,
  userId: string,
  role: OrgRole,
) {
  const existing = await getScopeMember(scopeId, userId);
  if (existing) return existing;

  await globalThis.services.db
    .insert(scopeMembers)
    .values({ scopeId, userId, role })
    .onConflictDoNothing();

  const member = await getScopeMember(scopeId, userId);
  if (!member) throw forbidden("You are not a member of this scope");
  return member;
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
