import { eq, and, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { forbidden } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";

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
