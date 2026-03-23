import { eq, and, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { badRequest, forbidden, notFound } from "../errors";
import { logger } from "../logger";
import type { OrgRole } from "@vm0/core";
import { slackOrgConnections } from "../../db/schema/slack-org-connection";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgPendingQuestions } from "../../db/schema/slack-org-pending-question";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";

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
  const client = await clerkClient();

  // Parallel: org info + memberships + invitations
  const [org, memberships, invitations] = await Promise.all([
    client.organizations.getOrganization({ organizationId: orgId }),
    client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
    }),
    client.organizations.getOrganizationInvitationList({
      organizationId: orgId,
      status: ["pending"],
    }),
  ]);

  const createdAt = new Date(org.createdAt);

  // Batch-resolve emails for all members in a single Clerk API call
  const userIds = memberships.data
    .map((m) => m.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));

  const userMap = new Map<
    string,
    {
      email: string;
      firstName: string | null;
      lastName: string | null;
      imageUrl: string;
    }
  >();
  if (userIds.length > 0) {
    const users = await client.users.getUserList({ userId: userIds });
    for (const user of users.data) {
      const primaryEmail = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      userMap.set(user.id, {
        email: primaryEmail?.emailAddress ?? "",
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: user.imageUrl,
      });
    }
  }

  const members = memberships.data.map((membership) => {
    const uid = membership.publicUserData?.userId ?? "";
    const profile = userMap.get(uid);
    return {
      userId: uid,
      email: profile?.email ?? "",
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      imageUrl: profile?.imageUrl ?? "",
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

  // Only expose pending invitations to admins
  const pendingInvitations =
    callerRole === "admin"
      ? invitations.data.map((inv) => ({
          email: inv.emailAddress,
          role: mapClerkRole(inv.role),
          createdAt: new Date(inv.createdAt).toISOString(),
        }))
      : [];

  return {
    slug: orgSlug,
    role: callerRole,
    members,
    pendingInvitations,
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
 * Clean up org-scoped data when a user leaves or is removed from an org.
 * Called after Clerk membership is revoked.
 */
async function cleanupOrgMember(userId: string, orgId: string): Promise<void> {
  const db = globalThis.services.db;

  // Resolve the Slack workspace bound to this org (1:1 relationship)
  const [installation] = await db
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, orgId))
    .limit(1);

  if (installation) {
    // Find the user's connection in this workspace
    const connections = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.vm0UserId, userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      );

    if (connections.length > 0) {
      const connectionIds = connections.map((c) => c.id);
      // Delete pending questions first (no cascade from connection)
      await db
        .delete(slackOrgPendingQuestions)
        .where(inArray(slackOrgPendingQuestions.connectionId, connectionIds));
      // Delete connections (cascades to slack_org_thread_sessions)
      await db
        .delete(slackOrgConnections)
        .where(inArray(slackOrgConnections.id, connectionIds));
    }
  }

  // Invalidate membership cache
  await db
    .delete(orgMembersCache)
    .where(
      and(eq(orgMembersCache.userId, userId), eq(orgMembersCache.orgId, orgId)),
    );

  // Delete member preferences
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, userId),
        eq(orgMembersMetadata.orgId, orgId),
      ),
    );
}

/**
 * Update a member's role in the org.
 * Requires admin role.
 */
export async function updateMemberRole(
  callerUserId: string,
  orgId: string,
  callerRole: OrgRole,
  targetEmail: string,
  newRole: OrgRole,
) {
  if (callerRole !== "admin") {
    throw forbidden("Only admins can change member roles");
  }

  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [targetEmail] });

  if (users.data.length === 0) {
    throw notFound(`User with email "${targetEmail}" not found`);
  }

  const targetUserId = users.data[0]!.id;

  // Self-demotion: admin can downgrade themselves only if another admin exists
  if (targetUserId === callerUserId) {
    if (newRole !== "member") {
      throw badRequest("Cannot change your own role");
    }
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: orgId,
      });
    const adminCount = memberships.data.filter(
      (m) => m.role === "org:admin",
    ).length;
    if (adminCount < 2) {
      throw badRequest(
        "Cannot demote yourself — you are the only admin. Add another admin first.",
      );
    }
  }

  await client.organizations.updateOrganizationMembership({
    organizationId: orgId,
    userId: targetUserId,
    role: newRole === "admin" ? "org:admin" : "org:member",
  });

  log.debug("Member role updated", { orgId, targetEmail, newRole });
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

  await cleanupOrgMember(targetUserId, orgId);
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

  await cleanupOrgMember(userId, orgId);
  log.debug("User left org", { orgId, userId });
}

/**
 * Delete an org.
 * Requires admin role. Deletes from Clerk and cleans up local data.
 */
export async function deleteOrg(
  callerUserId: string,
  orgId: string,
  callerRole: OrgRole,
) {
  if (callerRole !== "admin") {
    throw forbidden("Only admins can delete the organization");
  }

  const client = await clerkClient();

  // Get all members to clean up their data
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
  });

  const memberUserIds = memberships.data
    .map((m) => m.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));

  // Clean up each member's org-scoped data
  for (const userId of memberUserIds) {
    await cleanupOrgMember(userId, orgId);
  }

  // Delete the org from Clerk
  await client.organizations.deleteOrganization(orgId);

  log.debug("Organization deleted", { orgId, callerUserId });
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
