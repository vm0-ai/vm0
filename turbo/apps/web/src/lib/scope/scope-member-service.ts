import { clerkClient } from "@clerk/nextjs/server";
import { eq, and, asc } from "drizzle-orm";
import { scopeMembers } from "../../db/schema/scope-member";
import { scopes } from "../../db/schema/scope";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import type { ScopeRole } from "@vm0/core";
import { scopeRoleSchema } from "@vm0/core";

const log = logger("service:scope-member");

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
  return { ...member, role: scopeRoleSchema.parse(member.role) };
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

/**
 * Map Clerk's internal role string to our ScopeRole type.
 */
function mapClerkRole(clerkRole: string): ScopeRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Lookup a scope by ID and verify it has a Clerk org link.
 * Throws notFound if the scope doesn't exist or isn't linked.
 */
async function getScopeWithClerkOrg(scopeId: string) {
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, scopeId))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Scope not found");
  }

  return scope as typeof scope & { clerkOrgId: string };
}

/**
 * Get scope members list.
 */
export async function getScopeMembers(clerkUserId: string, scopeId: string) {
  const scope = await getScopeWithClerkOrg(scopeId);

  // Get members from Clerk
  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: scope.clerkOrgId,
  });

  // Batch-resolve emails for all members in a single Clerk API call
  const userIds = memberships.data
    .map((m) => m.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));

  const emailMap = new Map<string, string>();
  if (userIds.length > 0) {
    const users = await client.users.getUserList({ userId: userIds });
    for (const user of users.data) {
      const primaryEmail = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      emailMap.set(user.id, primaryEmail?.emailAddress ?? "");
    }
  }

  const members = memberships.data.map((membership) => {
    const userId = membership.publicUserData?.userId ?? "";
    return {
      userId,
      email: emailMap.get(userId) ?? "",
      role: mapClerkRole(membership.role),
      joinedAt: membership.createdAt
        ? new Date(membership.createdAt).toISOString()
        : new Date().toISOString(),
    };
  });

  // Determine caller's role
  const callerMembership = memberships.data.find(
    (m) => m.publicUserData?.userId === clerkUserId,
  );
  const callerRole = callerMembership
    ? mapClerkRole(callerMembership.role)
    : "member";

  return {
    slug: scope.slug,
    role: callerRole,
    members,
    createdAt: scope.createdAt.toISOString(),
  };
}

/**
 * Invite a member to the scope.
 * Requires admin role.
 */
export async function inviteMember(
  callerUserId: string,
  scopeId: string,
  role: ScopeRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can invite members");
  }

  const scope = await getScopeWithClerkOrg(scopeId);

  const client = await clerkClient();
  await client.organizations.createOrganizationInvitation({
    organizationId: scope.clerkOrgId,
    emailAddress: email,
    inviterUserId: callerUserId,
    role: "org:member",
  });

  // Resolve invitee's Clerk user ID (if they already have an account)
  // and create scope_members record eagerly so they have access immediately.
  const users = await client.users.getUserList({ emailAddress: [email] });
  if (users.data.length > 0) {
    const inviteeUserId = users.data[0]!.id;
    await globalThis.services.db
      .insert(scopeMembers)
      .values({
        scopeId,
        userId: inviteeUserId,
        role: "member",
      })
      .onConflictDoNothing();
  }

  log.debug("Invitation sent", { scopeId, email });
}

/**
 * Remove a member from the scope.
 * Requires admin role.
 */
export async function removeMember(
  callerUserId: string,
  scopeId: string,
  role: ScopeRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can remove members");
  }

  const scope = await getScopeWithClerkOrg(scopeId);

  // Resolve email to Clerk user ID
  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [email] });

  if (users.data.length === 0) {
    throw notFound(`User with email "${email}" not found`);
  }

  const targetUserId = users.data[0]!.id;

  // Cannot remove self
  if (targetUserId === callerUserId) {
    throw badRequest("Cannot remove yourself. Use 'scope leave' instead.");
  }

  // Find membership to get membershipId
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: scope.clerkOrgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === targetUserId,
  );

  if (!membership) {
    throw notFound(`User "${email}" is not a member of this scope`);
  }

  // Remove from Clerk
  await client.organizations.deleteOrganizationMembership({
    organizationId: scope.clerkOrgId,
    userId: targetUserId,
  });

  // Remove from scope_members
  await globalThis.services.db
    .delete(scopeMembers)
    .where(
      and(
        eq(scopeMembers.scopeId, scopeId),
        eq(scopeMembers.userId, targetUserId),
      ),
    );

  log.debug("Member removed", { scopeId, targetUserId, email });
}

/**
 * Leave the scope.
 * Admins cannot leave (they must add another admin or delete the scope).
 */
export async function leaveScope(
  clerkUserId: string,
  scopeId: string,
  role: ScopeRole,
) {
  if (role === "admin") {
    throw forbidden(
      "Admins cannot leave a scope. Add another admin or delete the scope.",
    );
  }

  const scope = await getScopeWithClerkOrg(scopeId);

  // Remove own membership from Clerk
  const client = await clerkClient();
  await client.organizations.deleteOrganizationMembership({
    organizationId: scope.clerkOrgId,
    userId: clerkUserId,
  });

  // Remove from scope_members
  await globalThis.services.db
    .delete(scopeMembers)
    .where(
      and(
        eq(scopeMembers.scopeId, scopeId),
        eq(scopeMembers.userId, clerkUserId),
      ),
    );

  log.debug("User left scope", { scopeId, clerkUserId });
}

/**
 * Get all scopes accessible to a user (via scope_members).
 */
export async function getUserAccessibleScopes(
  clerkUserId: string,
): Promise<Array<{ slug: string; role: string }>> {
  const memberScopes = await globalThis.services.db
    .select({
      slug: scopes.slug,
      role: scopeMembers.role,
    })
    .from(scopeMembers)
    .innerJoin(scopes, eq(scopeMembers.scopeId, scopes.id))
    .where(eq(scopeMembers.userId, clerkUserId));

  return memberScopes.map((s) => ({
    slug: s.slug,
    role: s.role,
  }));
}
