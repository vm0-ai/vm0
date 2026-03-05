import { clerkClient } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { scopeMembers } from "../../db/schema/scope-member";
import { badRequest, forbidden, notFound } from "../errors";
import { getScopeBySlug, isVm0Admin } from "../scope/scope-service";
import { getPrimaryAdminMembership } from "../scope/scope-member-service";
import { getUserEmail } from "../auth/get-user-email";
import { logger } from "../logger";
import type { OrgRole } from "@vm0/core";

const log = logger("service:org");

/**
 * Map Clerk's internal role string to our OrgRole type.
 */
function mapClerkRole(clerkRole: string): OrgRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Lookup an organization scope by ID and verify it has a Clerk org link.
 * Throws notFound if the scope doesn't exist or isn't linked.
 */
async function getOrgScope(scopeId: string) {
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, scopeId))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Organization not found");
  }

  return scope as typeof scope & { clerkOrgId: string };
}

/**
 * Create a new organization.
 * Creates a Clerk Organization and a local scope.
 */
export async function createOrganization(clerkUserId: string, slug: string) {
  // TODO: "vm0" is hardcoded as the system scope slug. This should be configurable.
  if (slug.startsWith("vm0")) {
    const email = await getUserEmail(clerkUserId);
    if (!isVm0Admin(email)) {
      throw badRequest(`Scope slug "${slug}" is reserved`);
    }
  }

  // Check one-org-per-user limit via scope_members (admin memberships)
  const existingAdmin = await getPrimaryAdminMembership(clerkUserId);
  if (existingAdmin) {
    const [existingScope] = await globalThis.services.db
      .select({ slug: scopes.slug })
      .from(scopes)
      .where(eq(scopes.id, existingAdmin.scopeId))
      .limit(1);
    throw badRequest(
      `You already own an organization: ${existingScope?.slug ?? existingAdmin.scopeId}`,
    );
  }

  // Check slug availability
  const existingScope = await getScopeBySlug(slug);
  if (existingScope) {
    throw badRequest(`Scope slug "${slug}" is already taken`);
  }

  // Create Clerk Organization
  const client = await clerkClient();
  const clerkOrg = await client.organizations.createOrganization({
    name: slug,
    createdBy: clerkUserId,
  });

  // Create local scope + admin membership atomically
  const scope = await globalThis.services.db.transaction(async (tx) => {
    const [newScope] = await tx
      .insert(scopes)
      .values({
        slug,
        clerkOrgId: clerkOrg.id,
      })
      .returning();

    if (!newScope) {
      throw new Error("Failed to create organization scope");
    }

    await tx.insert(scopeMembers).values({
      scopeId: newScope.id,
      userId: clerkUserId,
      role: "admin",
    });

    return newScope;
  });

  log.debug("Organization created", {
    scopeId: scope.id,
    slug,
    clerkOrgId: clerkOrg.id,
  });

  return {
    scope,
    role: "admin" as const,
  };
}

/**
 * Get organization status including members list.
 */
export async function getOrganizationStatus(
  clerkUserId: string,
  scopeId: string,
) {
  const scope = await getOrgScope(scopeId);

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
 * Invite a member to the organization.
 * Requires admin role.
 */
export async function inviteMember(
  callerUserId: string,
  scopeId: string,
  role: OrgRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can invite members");
  }

  const scope = await getOrgScope(scopeId);

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
 * Remove a member from the organization.
 * Requires admin role.
 */
export async function removeMember(
  callerUserId: string,
  scopeId: string,
  role: OrgRole,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can remove members");
  }

  const scope = await getOrgScope(scopeId);

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
    organizationId: scope.clerkOrgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === targetUserId,
  );

  if (!membership) {
    throw notFound(`User "${email}" is not a member of this organization`);
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
 * Leave the organization.
 * Admins cannot leave (they must transfer ownership or delete the org).
 */
export async function leaveOrganization(
  clerkUserId: string,
  scopeId: string,
  role: OrgRole,
) {
  if (role === "admin") {
    throw forbidden(
      "Admins cannot leave an organization. Transfer ownership first.",
    );
  }

  const scope = await getOrgScope(scopeId);

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

  log.debug("User left organization", { scopeId, clerkUserId });
}

/**
 * Get all scopes accessible to a user (via scope_members).
 */
export async function getUserAccessibleScopes(
  clerkUserId: string,
): Promise<Array<{ slug: string; role: string }>> {
  // Query all scopes the user is a member of via scope_members
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
