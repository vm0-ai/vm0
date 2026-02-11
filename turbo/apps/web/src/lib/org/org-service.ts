import { clerkClient } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { badRequest, forbidden, notFound } from "../errors";
import { getUserScopeByClerkId, getScopeBySlug } from "../scope/scope-service";
import {
  generateOrgAccessToken,
  revokeOrgAccessTokens,
} from "./org-token-service";
import { logger } from "../logger";

const log = logger("service:org");

/**
 * Create a new organization.
 * Creates a Clerk Organization and a local scope with type=organization.
 */
export async function createOrganization(clerkUserId: string, slug: string) {
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
      `You already have an organization: ${existingOrg[0]!.slug}`,
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
  const [scope] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug,
      type: "organization",
      ownerId: clerkUserId,
      clerkOrgId: clerkOrg.id,
    })
    .returning();

  log.debug("Organization created", {
    scopeId: scope!.id,
    slug,
    clerkOrgId: clerkOrg.id,
  });

  // Generate org access token for creator (admin)
  const { token, expiresAt } = await generateOrgAccessToken(
    clerkUserId,
    scope!.id,
    "admin",
  );

  return {
    scope: scope!,
    token,
    expiresAt,
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
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.id, scopeId), eq(scopes.type, "organization")))
    .limit(1);

  if (!scope) {
    throw notFound("Organization not found");
  }

  if (!scope.clerkOrgId) {
    throw notFound("Organization not linked to Clerk");
  }

  // Get members from Clerk
  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: scope.clerkOrgId,
  });

  // Resolve emails for each member
  const members = await Promise.all(
    memberships.data.map(async (membership) => {
      const userId = membership.publicUserData?.userId ?? "";
      let email = "";
      if (userId) {
        const user = await client.users.getUser(userId);
        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId,
        );
        email = primaryEmail?.emailAddress ?? "";
      }

      return {
        userId,
        email,
        role:
          membership.role === "org:admin"
            ? ("admin" as const)
            : ("member" as const),
        joinedAt: membership.createdAt
          ? new Date(membership.createdAt).toISOString()
          : new Date().toISOString(),
      };
    }),
  );

  // Determine caller's role
  const callerMembership = memberships.data.find(
    (m) => m.publicUserData?.userId === clerkUserId,
  );
  const callerRole =
    callerMembership?.role === "org:admin" ? "admin" : "member";

  return {
    slug: scope.slug,
    role: callerRole as "admin" | "member",
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
  role: string,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can invite members");
  }

  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.id, scopeId), eq(scopes.type, "organization")))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Organization not found");
  }

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
  role: string,
  email: string,
) {
  if (role !== "admin") {
    throw forbidden("Only admins can remove members");
  }

  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.id, scopeId), eq(scopes.type, "organization")))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Organization not found");
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
  role: string,
) {
  if (role === "admin") {
    throw forbidden(
      "Admins cannot leave an organization. Transfer ownership first.",
    );
  }

  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(and(eq(scopes.id, scopeId), eq(scopes.type, "organization")))
    .limit(1);

  if (!scope?.clerkOrgId) {
    throw notFound("Organization not found");
  }

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
    role?: string;
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

  // For each Clerk org membership, find matching local scope
  for (const membership of memberships.data) {
    const clerkOrgId = membership.organization.id;
    const [scope] = await globalThis.services.db
      .select()
      .from(scopes)
      .where(
        and(eq(scopes.clerkOrgId, clerkOrgId), eq(scopes.type, "organization")),
      )
      .limit(1);

    if (scope) {
      results.push({
        slug: scope.slug,
        type: "organization",
        role: membership.role === "org:admin" ? "admin" : "member",
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

    const role = membership.role === "org:admin" ? "admin" : "member";
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

  // System scopes cannot be activated
  throw forbidden("System scopes cannot be activated");
}
