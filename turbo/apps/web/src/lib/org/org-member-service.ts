import { clerkClient } from "@clerk/nextjs/server";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import type { OrgRole } from "@vm0/core";

const log = logger("service:org-member");

/**
 * Require a user to be a member of an org, or throw 403.
 * Verifies membership via Clerk API using the org ID directly.
 */
export async function requireOrgMember(orgId: string, userId: string) {
  if (!orgId || orgId.startsWith("pending_")) {
    throw forbidden("You are not a member of this organization");
  }

  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === userId,
  );
  if (!membership) {
    throw forbidden("You are not a member of this organization");
  }

  return {
    role: mapClerkRole(membership.role),
    userId,
    orgId,
  };
}

/**
 * Map Clerk's internal role string to our OrgRole type.
 */
function mapClerkRole(clerkRole: string): OrgRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Get org members list.
 * Reads membership data directly from Clerk API.
 */
export async function getOrgMembers(
  userId: string,
  orgId: string,
  orgSlug: string,
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
    slug: orgSlug,
    role: callerRole,
    members,
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Invite a member to the org.
 * Requires admin role.
 */
export async function inviteMember(
  callerUserId: string,
  orgId: string,
  role: OrgRole,
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
 * Remove a member from the org.
 * Requires admin role.
 */
export async function removeMember(
  callerUserId: string,
  orgId: string,
  role: OrgRole,
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
    throw badRequest("Cannot remove yourself. Use 'org leave' instead.");
  }

  // Find membership to get membershipId
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === targetUserId,
  );

  if (!membership) {
    throw notFound(`User "${email}" is not a member of this organization`);
  }

  // Remove from Clerk
  await client.organizations.deleteOrganizationMembership({
    organizationId: orgId,
    userId: targetUserId,
  });

  log.debug("Member removed", { orgId, targetUserId, email });
}

/**
 * Leave the org.
 * Admins cannot leave (they must add another admin or delete the org).
 */
export async function leaveOrg(userId: string, orgId: string, role: OrgRole) {
  if (role === "admin") {
    throw forbidden(
      "Admins cannot leave an org. Add another admin or delete the org.",
    );
  }

  // Remove own membership from Clerk
  const client = await clerkClient();
  await client.organizations.deleteOrganizationMembership({
    organizationId: orgId,
    userId: userId,
  });

  log.debug("User left org", { orgId, userId });
}

/**
 * Get all orgs accessible to a user (via Clerk organization memberships).
 */
export async function getUserAccessibleOrgs(
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
