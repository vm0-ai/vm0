import { auth, clerkClient } from "@clerk/nextjs/server";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import { getOrgData } from "./org-cache-service";
import type { ScopeRole } from "@vm0/core";
import type { ResolvedScope, ResolvedMember } from "./resolve-scope";

const log = logger("service:scope-member");

/**
 * Require a user to be a member of a scope, or throw 403.
 * Verifies membership via Clerk API using the org ID directly.
 */
export async function requireScopeMember(orgId: string, userId: string) {
  if (!orgId || orgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this scope");
  }

  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
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
    orgId,
  };
}

/**
 * Get user's default scope using org_cache (never queries scopes table).
 *
 * Fast path: if the JWT session contains an orgId, look up via org_cache
 * — no Clerk API call needed.
 *
 * Slow path: for CLI tokens (no JWT) or when the JWT org has no cache entry,
 * fall back to Clerk Backend API to discover the user's org memberships.
 */
export async function getDefaultScope(
  userId: string,
): Promise<{ scope: ResolvedScope; member: ResolvedMember }> {
  // JWT fast path: use active org from session token
  const authResult = await auth();
  if (authResult.orgId) {
    try {
      const orgData = await getOrgData(authResult.orgId);
      return {
        scope: orgData,
        member: {
          role: mapClerkRole(authResult.orgRole ?? "org:member"),
          userId,
        },
      };
    } catch {
      // JWT orgId not found in Clerk — fall through to slow path
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

  for (const membership of candidates) {
    const orgId = membership.organization.id;
    const orgData = await getOrgData(orgId);
    return {
      scope: orgData,
      member: {
        role: mapClerkRole(membership.role),
        userId,
      },
    };
  }

  throw notFound("No scope found for user");
}

/**
 * Resolve org ID: use the provided value or fall back to the user's default scope.
 * Replaces the old resolveScopeId() which returned a scope UUID.
 */
export async function resolveOrgId(
  userId: string,
  orgId?: string | null,
  tokenOrgId?: string | null,
): Promise<string> {
  if (orgId) return orgId;
  if (tokenOrgId) return tokenOrgId;
  const { scope } = await getDefaultScope(userId);
  return scope.orgId;
}

/**
 * Map Clerk's internal role string to our ScopeRole type.
 */
function mapClerkRole(clerkRole: string): ScopeRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Get scope members list.
 * Reads membership data directly from Clerk API.
 */
export async function getScopeMembers(
  userId: string,
  orgId: string,
  scopeSlug: string,
) {
  // Get members and org info from Clerk
  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: orgId,
  });
  const createdAt = new Date(org.createdAt);
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
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
    (m) => m.publicUserData?.userId === userId,
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
  orgId: string,
  role: ScopeRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can invite members");
  }

  const client = await clerkClient();
  await client.organizations.createOrganizationInvitation({
    organizationId: orgId,
    emailAddress: email,
    inviterUserId: callerUserId,
    role: "org:member",
  });

  log.debug("Invitation sent", { orgId, email });
}

/**
 * Remove a member from the scope.
 * Requires admin role.
 */
export async function removeMember(
  callerUserId: string,
  orgId: string,
  role: ScopeRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can remove members");
  }

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
    organizationId: orgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === targetUserId,
  );

  if (!membership) {
    throw notFound(`User "${email}" is not a member of this scope`);
  }

  // Remove from Clerk
  await client.organizations.deleteOrganizationMembership({
    organizationId: orgId,
    userId: targetUserId,
  });

  log.debug("Member removed", { orgId, targetUserId, email });
}

/**
 * Leave the scope.
 * Admins cannot leave (they must add another admin or delete the scope).
 */
export async function leaveScope(
  userId: string,
  orgId: string,
  role: ScopeRole,
) {
  if (role === "admin") {
    throw forbidden(
      "Admins cannot leave a scope. Add another admin or delete the scope.",
    );
  }

  // Remove own membership from Clerk
  const client = await clerkClient();
  await client.organizations.deleteOrganizationMembership({
    organizationId: orgId,
    userId: userId,
  });

  log.debug("User left scope", { orgId, userId });
}

/**
 * Get all scopes accessible to a user (via Clerk organization memberships).
 */
export async function getUserAccessibleScopes(
  userId: string,
): Promise<Array<{ slug: string; role: string }>> {
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId: userId,
  });
  return memberships.data.map((m) => ({
    slug: m.organization.slug,
    role: mapClerkRole(m.role),
  }));
}
