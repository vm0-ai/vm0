import { eq, and, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { badRequest, forbidden, notFound } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";

const log = logger("service:org-member");

const CLERK_API_BASE = "https://api.clerk.com/v1";

/**
 * Zod schema for Clerk membership request REST API response.
 * The backend SDK doesn't expose membership request methods yet,
 * so we call the REST API directly and validate the response shape at runtime.
 */
const membershipRequestDataSchema = z.object({
  id: z.string(),
  public_user_data: z.object({ user_id: z.string().optional() }).optional(),
  created_at: z.number(),
});

const clerkMembershipRequestsResponseSchema = z.object({
  data: z.array(membershipRequestDataSchema),
});

type MembershipRequestData = z.infer<typeof membershipRequestDataSchema>;

function getClerkSecretKey(): string {
  return globalThis.services.env.CLERK_SECRET_KEY;
}

async function fetchMembershipRequests(
  orgId: string,
): Promise<MembershipRequestData[]> {
  const secretKey = getClerkSecretKey();
  const res = await fetch(
    `${CLERK_API_BASE}/organizations/${orgId}/membership_requests?status=pending`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
    },
  );
  if (res.status === 404) {
    log.warn(
      "Membership requests endpoint returned 404 — feature may be disabled for org",
      { orgId },
    );
    return [];
  }
  if (!res.ok) {
    throw new Error(
      `Failed to fetch membership requests for org ${orgId}: HTTP ${res.status}`,
    );
  }
  const body = clerkMembershipRequestsResponseSchema.parse(await res.json());
  return body.data;
}

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

  const membership = memberships.data.find((m) => {
    return m.publicUserData?.userId === userId;
  });
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
export async function getOrgMembers(userId: string, orgId: string) {
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
    .map((m) => {
      return m.publicUserData?.userId;
    })
    .filter((id): id is string => {
      return Boolean(id);
    });

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
      const primaryEmail = user.emailAddresses.find((e) => {
        return e.id === user.primaryEmailAddressId;
      });
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
  const callerMembership = memberships.data.find((m) => {
    return m.publicUserData?.userId === userId;
  });
  const callerRole = callerMembership
    ? mapClerkRole(callerMembership.role)
    : "member";

  // Only expose pending invitations and membership requests to admins
  const pendingInvitations =
    callerRole === "admin"
      ? invitations.data.map((inv) => {
          return {
            id: inv.id,
            email: inv.emailAddress,
            role: mapClerkRole(inv.role),
            createdAt: new Date(inv.createdAt).toISOString(),
          };
        })
      : [];

  // Fetch membership requests (only for admins)
  let membershipRequests: Array<{
    id: string;
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    imageUrl: string;
    createdAt: string;
  }> = [];

  if (callerRole === "admin") {
    const requestsData = await fetchMembershipRequests(orgId);

    if (requestsData.length > 0) {
      const requestUserIds = requestsData
        .map((r: MembershipRequestData) => {
          return r.public_user_data?.user_id;
        })
        .filter((id: string | undefined): id is string => {
          return Boolean(id);
        });

      const requestUserMap = new Map<
        string,
        {
          email: string;
          firstName: string | null;
          lastName: string | null;
          imageUrl: string;
        }
      >();
      if (requestUserIds.length > 0) {
        const requestUsers = await client.users.getUserList({
          userId: requestUserIds,
        });
        for (const user of requestUsers.data) {
          const primaryEmail = user.emailAddresses.find((e) => {
            return e.id === user.primaryEmailAddressId;
          });
          requestUserMap.set(user.id, {
            email: primaryEmail?.emailAddress ?? "",
            firstName: user.firstName,
            lastName: user.lastName,
            imageUrl: user.imageUrl,
          });
        }
      }

      membershipRequests = requestsData.map((req: MembershipRequestData) => {
        const uid = req.public_user_data?.user_id ?? "";
        const profile = requestUserMap.get(uid);
        return {
          id: req.id,
          userId: uid,
          email: profile?.email ?? "",
          firstName: profile?.firstName ?? null,
          lastName: profile?.lastName ?? null,
          imageUrl: profile?.imageUrl ?? "",
          createdAt: new Date(req.created_at).toISOString(),
        };
      });
    }
  }

  return {
    slug: org.slug,
    role: callerRole,
    members,
    pendingInvitations,
    membershipRequests,
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
  callerRole: OrgRole,
  email: string,
  inviteRole: OrgRole = "member",
) {
  if (callerRole !== "admin") {
    throw forbidden("Only admins can invite members");
  }

  const client = await clerkClient();
  await client.organizations.createOrganizationInvitation({
    organizationId: orgId,
    emailAddress: email,
    inviterUserId: callerUserId,
    role: inviteRole === "admin" ? "org:admin" : "org:member",
  });

  log.debug("Invitation sent", { orgId, email, inviteRole });
}

/**
 * Revoke a pending invitation.
 * Requires admin role.
 */
export async function revokeInvitation(
  orgId: string,
  role: OrgRole,
  invitationId: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can revoke invitations");
  }

  const client = await clerkClient();
  await client.organizations.revokeOrganizationInvitation({
    organizationId: orgId,
    invitationId,
  });

  log.debug("Invitation revoked", { orgId, invitationId });
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
      const connectionIds = connections.map((c) => {
        return c.id;
      });
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
    const adminCount = memberships.data.filter((m) => {
      return m.role === "org:admin";
    }).length;
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

  const membership = memberships.data.find((m) => {
    return m.publicUserData?.userId === targetUserId;
  });

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
    .map((m) => {
      return m.publicUserData?.userId;
    })
    .filter((id): id is string => {
      return Boolean(id);
    });

  // Clean up each member's org-scoped data
  for (const userId of memberUserIds) {
    await cleanupOrgMember(userId, orgId);
  }

  // Delete the org from Clerk
  await client.organizations.deleteOrganization(orgId);

  log.debug("Organization deleted", { orgId, callerUserId });
}
