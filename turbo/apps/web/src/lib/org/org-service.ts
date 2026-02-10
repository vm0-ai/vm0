import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { orgMemberships } from "../../db/schema/org-membership";
import { orgInvitations } from "../../db/schema/org-invitation";
import { badRequest, notFound, forbidden } from "../errors";
import { logger } from "../logger";
import type { OrgMembershipRole } from "../../db/schema/org-membership";

const log = logger("service:org");

const INVITE_EXPIRY_DAYS = 7;
const INVITE_TOKEN_LENGTH = 32;

/**
 * Check if a user can create an organization (1 org per user limit)
 */
async function canCreateOrganization(clerkUserId: string): Promise<boolean> {
  const existingOrg = await getUserOwnedOrganization(clerkUserId);
  return existingOrg === null;
}

/**
 * Get the organization owned by a user (if any)
 */
export async function getUserOwnedOrganization(clerkUserId: string) {
  // Find org scope where user is owner
  const result = await globalThis.services.db
    .select({
      scope: scopes,
      membership: orgMemberships,
    })
    .from(orgMemberships)
    .innerJoin(scopes, eq(scopes.id, orgMemberships.scopeId))
    .where(
      and(
        eq(orgMemberships.userId, clerkUserId),
        eq(orgMemberships.role, "owner"),
        eq(scopes.type, "organization"),
      ),
    )
    .limit(1);

  return result[0]?.scope ?? null;
}

/**
 * Create a new organization
 */
export async function createOrganization(clerkUserId: string, slug: string) {
  // Check if user already owns an org
  const canCreate = await canCreateOrganization(clerkUserId);
  if (!canCreate) {
    throw badRequest("You can only create one organization");
  }

  // Check if slug already exists
  const existingScope = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.slug, slug))
    .limit(1);

  if (existingScope.length > 0) {
    throw badRequest(`Scope "${slug}" already exists`);
  }

  log.debug("creating organization", { clerkUserId, slug });

  // Create the organization scope
  const [scope] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug,
      type: "organization",
      ownerId: clerkUserId,
    })
    .returning();

  // Add creator as owner member
  await globalThis.services.db.insert(orgMemberships).values({
    scopeId: scope!.id,
    userId: clerkUserId,
    role: "owner",
    joinedAt: new Date(),
  });

  log.debug("organization created", { scopeId: scope!.id, slug });

  return scope!;
}

/**
 * Get all members of an organization
 */
export async function getOrgMembers(scopeId: string) {
  const result = await globalThis.services.db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.scopeId, scopeId));

  return result;
}

/**
 * Check if a user is a member of an organization
 */
export async function isOrgMember(
  clerkUserId: string,
  scopeId: string,
): Promise<boolean> {
  const result = await globalThis.services.db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.scopeId, scopeId),
        eq(orgMemberships.userId, clerkUserId),
      ),
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Check if a user is the owner of an organization
 */
export async function isOrgOwner(
  clerkUserId: string,
  scopeId: string,
): Promise<boolean> {
  const result = await globalThis.services.db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.scopeId, scopeId),
        eq(orgMemberships.userId, clerkUserId),
        eq(orgMemberships.role, "owner"),
      ),
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Add a member to an organization
 */
async function addOrgMember(
  scopeId: string,
  clerkUserId: string,
  role: OrgMembershipRole = "member",
) {
  // Check if already a member
  const existing = await isOrgMember(clerkUserId, scopeId);
  if (existing) {
    throw badRequest("User is already a member of this organization");
  }

  await globalThis.services.db.insert(orgMemberships).values({
    scopeId,
    userId: clerkUserId,
    role,
    joinedAt: new Date(),
  });

  log.debug("member added to organization", { scopeId, clerkUserId, role });
}

/**
 * Remove a member from an organization
 */
export async function removeOrgMember(scopeId: string, clerkUserId: string) {
  // Cannot remove owner
  const isOwner = await isOrgOwner(clerkUserId, scopeId);
  if (isOwner) {
    throw forbidden("Cannot remove the organization owner");
  }

  const result = await globalThis.services.db
    .delete(orgMemberships)
    .where(
      and(
        eq(orgMemberships.scopeId, scopeId),
        eq(orgMemberships.userId, clerkUserId),
      ),
    )
    .returning();

  if (result.length === 0) {
    throw notFound("Member not found in organization");
  }

  log.debug("member removed from organization", { scopeId, clerkUserId });
}

/**
 * Leave an organization (member only, not owner)
 */
export async function leaveOrganization(clerkUserId: string, scopeId: string) {
  // Owner cannot leave
  const isOwner = await isOrgOwner(clerkUserId, scopeId);
  if (isOwner) {
    throw forbidden("Owner cannot leave the organization. Delete it instead.");
  }

  // Check if member
  const isMember = await isOrgMember(clerkUserId, scopeId);
  if (!isMember) {
    throw notFound("You are not a member of this organization");
  }

  await globalThis.services.db
    .delete(orgMemberships)
    .where(
      and(
        eq(orgMemberships.scopeId, scopeId),
        eq(orgMemberships.userId, clerkUserId),
      ),
    );

  log.debug("user left organization", { scopeId, clerkUserId });
}

/**
 * Generate a random invite token
 */
function generateInviteToken(): string {
  return crypto.randomBytes(INVITE_TOKEN_LENGTH).toString("hex");
}

/**
 * Create an invitation link for an organization
 */
export async function createInviteLink(
  scopeId: string,
  invitedBy: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateInviteToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

  await globalThis.services.db.insert(orgInvitations).values({
    scopeId,
    token,
    invitedBy,
    expiresAt,
  });

  log.debug("invite link created", { scopeId, invitedBy, expiresAt });

  return { token, expiresAt };
}

/**
 * Get an invitation by token
 */
export async function getInvitation(token: string) {
  const result = await globalThis.services.db
    .select({
      invitation: orgInvitations,
      scope: scopes,
    })
    .from(orgInvitations)
    .innerJoin(scopes, eq(scopes.id, orgInvitations.scopeId))
    .where(eq(orgInvitations.token, token))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Check if an invitation is valid (not expired, not used)
 */
export function isInvitationValid(
  invitation: typeof orgInvitations.$inferSelect,
): boolean {
  if (invitation.usedAt !== null) {
    return false;
  }
  if (new Date() > invitation.expiresAt) {
    return false;
  }
  return true;
}

/**
 * Accept an invitation and join the organization
 */
export async function acceptInvitation(token: string, clerkUserId: string) {
  const inviteData = await getInvitation(token);
  if (!inviteData) {
    throw notFound("Invitation not found");
  }

  const { invitation, scope } = inviteData;

  if (!isInvitationValid(invitation)) {
    throw badRequest("Invitation has expired or already been used");
  }

  // Check if already a member
  const existing = await isOrgMember(clerkUserId, scope.id);
  if (existing) {
    throw badRequest("You are already a member of this organization");
  }

  // Add member
  await addOrgMember(scope.id, clerkUserId, "member");

  // Mark invitation as used
  await globalThis.services.db
    .update(orgInvitations)
    .set({
      usedAt: new Date(),
      usedBy: clerkUserId,
    })
    .where(eq(orgInvitations.id, invitation.id));

  log.debug("invitation accepted", { token, clerkUserId, scopeId: scope.id });

  return scope;
}
