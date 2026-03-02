import { clerkClient } from "@clerk/nextjs/server";
import { eq, and, inArray } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { badRequest, forbidden, notFound } from "../errors";
import {
  getUserScopeByClerkId,
  getScopeBySlug,
  isVm0Admin,
} from "../scope/scope-service";
import {
  generateOrgAccessToken,
  revokeOrgAccessTokens,
} from "./org-token-service";
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
    .where(and(eq(scopes.id, scopeId), eq(scopes.type, "organization")))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Organization not found");
  }

  return scope as typeof scope & { clerkOrgId: string };
}

/**
 * Create a new organization.
 * Creates a Clerk Organization and a local scope with type=organization.
 */
export async function createOrganization(clerkUserId: string, slug: string) {
  // TODO: "vm0" is hardcoded as the system scope slug. This should be configurable.
  if (slug.startsWith("vm0")) {
    const email = await getUserEmail(clerkUserId);
    if (!isVm0Admin(email)) {
      throw badRequest(`Scope slug "${slug}" is reserved`);
    }
  }

  // Check one-org-per-user limit
  const existingOrg = await globalThis.services.db
    .select()
    .from(scopes)
    .where(
      and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "organization")),
    )
    .limit(1);

  if (existingOrg.length > 0) {
    throw badRequest(
      `You already own an organization: ${existingOrg[0]!.slug}`,
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
    slug,
    createdBy: clerkUserId,
  });

  // Create local scope
  const result = await globalThis.services.db
    .insert(scopes)
    .values({
      slug,
      type: "organization",
      ownerId: clerkUserId,
      clerkOrgId: clerkOrg.id,
    })
    .returning();

  const scope = result[0];
  if (!scope) {
    throw new Error("Failed to create organization scope");
  }

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
    inviterUserId: scope.ownerId!,
    role: "org:member",
  });

  log.debug("Invitation sent", { scopeId, email });
}

/**
 * Remove a member from the organization.
 * Requires admin role. Instantly revokes the removed user's org tokens.
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

  // Instant token revocation
  await revokeOrgAccessTokens(targetUserId, scopeId);

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

  // Instant token revocation
  await revokeOrgAccessTokens(clerkUserId, scopeId);

  log.debug("User left organization", { scopeId, clerkUserId });
}

/**
 * Get all scopes accessible to a user (personal + org memberships).
 */
export async function getUserAccessibleScopes(clerkUserId: string) {
  const results: Array<{
    slug: string;
    type: "personal" | "organization";
    role?: OrgRole;
  }> = [];

  // Get personal scope
  const personalScope = await getUserScopeByClerkId(clerkUserId);
  if (personalScope) {
    results.push({
      slug: personalScope.slug,
      type: "personal",
    });
  }

  // Get org memberships from Clerk
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId: clerkUserId,
  });

  if (memberships.data.length === 0) {
    return results;
  }

  // Batch-query all org scopes instead of N+1
  const clerkOrgIds = memberships.data.map((m) => m.organization.id);
  const orgScopes = await globalThis.services.db
    .select()
    .from(scopes)
    .where(
      and(
        inArray(scopes.clerkOrgId, clerkOrgIds),
        eq(scopes.type, "organization"),
      ),
    );

  const scopeByClerkOrgId = new Map(orgScopes.map((s) => [s.clerkOrgId, s]));

  for (const membership of memberships.data) {
    const scope = scopeByClerkOrgId.get(membership.organization.id);
    if (scope) {
      results.push({
        slug: scope.slug,
        type: "organization",
        role: mapClerkRole(membership.role),
      });
    }
  }

  return results;
}

/**
 * Verify membership and activate a scope.
 * For personal scopes: returns scope with empty token.
 * For org scopes: verifies Clerk membership and generates org access token.
 */
export async function verifyAndActivateScope(
  clerkUserId: string,
  slug: string,
) {
  const scope = await getScopeBySlug(slug);
  if (!scope) {
    throw notFound(`Scope "${slug}" not found`);
  }

  // Personal scope: verify ownership
  if (scope.type === "personal") {
    if (scope.ownerId !== clerkUserId) {
      throw forbidden("You don't have access to this scope");
    }
    return { scope, token: "", expiresAt: "" };
  }

  // Organization scope: verify Clerk membership
  if (scope.type === "organization") {
    if (!scope.clerkOrgId) {
      throw notFound("Organization not linked to Clerk");
    }

    const client = await clerkClient();
    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: scope.clerkOrgId,
      });

    const membership = memberships.data.find(
      (m) => m.publicUserData?.userId === clerkUserId,
    );

    if (!membership) {
      throw forbidden("You are not a member of this organization");
    }

    const role = mapClerkRole(membership.role);
    const { token, expiresAt } = await generateOrgAccessToken(
      clerkUserId,
      scope.id,
      role,
    );

    return {
      scope,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  throw forbidden("Scope cannot be activated");
}
