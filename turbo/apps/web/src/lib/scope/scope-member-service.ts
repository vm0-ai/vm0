import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import { getScopeByClerkOrgId, getScopesByClerkOrgIds } from "./scope-service";
import type { ScopeRole } from "@vm0/core";

const log = logger("service:scope-member");

/**
 * Require a user to be a member of a scope, or throw 403.
 * Verifies membership via Clerk API.
 */
export async function requireScopeMember(scopeId: string, userId: string) {
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, scopeId))
    .limit(1);

  if (!scope?.clerkOrgId || scope.clerkOrgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this scope");
  }

  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: scope.clerkOrgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === userId,
  );
  if (!membership) {
    throw forbidden("You are not a member of this scope");
  }

  return {
    role: mapClerkRole(membership.role),
    userId,
    scopeId,
  };
}

/**
 * Get user's default scope.
 *
 * Fast path: if the JWT session contains an orgId, look up the scope directly
 * from the database — no Clerk API call needed.
 *
 * Slow path: for CLI tokens (no JWT) or when the JWT org has no local scope,
 * fall back to Clerk Backend API to discover the user's org memberships.
 */
export async function getDefaultScope(userId: string) {
  // JWT fast path: use active org from session token
  const authResult = await auth();
  if (authResult.orgId) {
    const scope = await getScopeByClerkOrgId(authResult.orgId);
    if (scope) {
      return {
        scope,
        member: {
          role: mapClerkRole(authResult.orgRole ?? "org:member"),
          userId,
          scopeId: scope.id,
        },
      };
    }
  }

  // Slow path: Clerk API (CLI tokens, or JWT org has no local scope yet)
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
  });

  // Priority: admin orgs first, then any org
  const adminMembership = memberships.data.find((m) => m.role === "org:admin");
  const candidates = adminMembership
    ? [
        adminMembership,
        ...memberships.data.filter((m) => m !== adminMembership),
      ]
    : memberships.data;

  // Batch-fetch all scopes by Clerk org IDs in a single query
  const clerkOrgIds = candidates.map((m) => m.organization.id);
  const scopeMap = await getScopesByClerkOrgIds(clerkOrgIds);

  for (const membership of candidates) {
    const scope = scopeMap.get(membership.organization.id);
    if (scope) {
      return {
        scope,
        member: {
          role: mapClerkRole(membership.role),
          userId,
          scopeId: scope.id,
        },
      };
    }
  }

  throw notFound("No scope found for user");
}

/**
 * Resolve scope ID: use the provided value or fall back to the user's default scope.
 */
export async function resolveScopeId(
  userId: string,
  scopeId: string | undefined,
  tokenScopeId?: string | null,
): Promise<string> {
  if (scopeId) {
    return scopeId;
  }
  if (tokenScopeId) {
    return tokenScopeId;
  }
  const { scope } = await getDefaultScope(userId);
  return scope.id;
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
 * Reads membership data directly from Clerk API.
 */
export async function getScopeMembers(
  clerkUserId: string,
  clerkOrgId: string,
  scopeSlug: string,
  createdAt: Date,
) {
  // Get members from Clerk
  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: clerkOrgId,
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
    slug: scopeSlug,
    role: callerRole,
    members,
    createdAt: createdAt.toISOString(),
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

  log.debug("User left scope", { scopeId, clerkUserId });
}

/**
 * Get all scopes accessible to a user (via Clerk organization memberships).
 */
export async function getUserAccessibleScopes(
  clerkUserId: string,
): Promise<Array<{ slug: string; role: string }>> {
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId: clerkUserId,
  });
  return memberships.data.map((m) => ({
    slug: m.organization.slug,
    role: mapClerkRole(m.role),
  }));
}
