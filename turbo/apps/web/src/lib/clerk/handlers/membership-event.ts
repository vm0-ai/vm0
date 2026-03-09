import { eq, and } from "drizzle-orm";
import { scopes } from "../../../db/schema/scope";
import { scopeMembers } from "../../../db/schema/scope-member";
import { logger } from "../../logger";
import type { WebhookEvent } from "@clerk/nextjs/server";

const log = logger("webhook:clerk:membership");

type MembershipEvent = Extract<
  WebhookEvent,
  { type: `organizationMembership.${string}` }
>;

/**
 * Resolve a Clerk org ID to a scope ID.
 * Returns null if no scope is linked to the given Clerk org.
 */
async function resolveScopeId(clerkOrgId: string): Promise<string | null> {
  const [scope] = await globalThis.services.db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.clerkOrgId, clerkOrgId))
    .limit(1);
  return scope?.id ?? null;
}

/**
 * Map Clerk membership role to our role format.
 */
function mapRole(clerkRole: string): "admin" | "member" {
  return clerkRole === "org:admin" ? "admin" : "member";
}

/**
 * Handle organizationMembership.created — eagerly create scope_members record.
 */
export async function handleMembershipCreated(data: MembershipEvent["data"]) {
  const clerkOrgId = data.organization.id;
  const userId = data.public_user_data.user_id;
  const role = mapRole(data.role);

  const scopeId = await resolveScopeId(clerkOrgId);
  if (!scopeId) {
    log.debug("No scope found for Clerk org, skipping", { clerkOrgId });
    return;
  }

  await globalThis.services.db
    .insert(scopeMembers)
    .values({ scopeId, userId, role })
    .onConflictDoNothing();

  log.debug("Membership created", { scopeId, userId, role });
}

/**
 * Handle organizationMembership.updated — sync role changes.
 */
export async function handleMembershipUpdated(data: MembershipEvent["data"]) {
  const clerkOrgId = data.organization.id;
  const userId = data.public_user_data.user_id;
  const role = mapRole(data.role);

  const scopeId = await resolveScopeId(clerkOrgId);
  if (!scopeId) {
    log.debug("No scope found for Clerk org, skipping", { clerkOrgId });
    return;
  }

  await globalThis.services.db
    .update(scopeMembers)
    .set({ role, updatedAt: new Date() })
    .where(
      and(eq(scopeMembers.scopeId, scopeId), eq(scopeMembers.userId, userId)),
    );

  log.debug("Membership updated", { scopeId, userId, role });
}

/**
 * Handle organizationMembership.deleted — remove scope_members record.
 */
export async function handleMembershipDeleted(data: MembershipEvent["data"]) {
  const clerkOrgId = data.organization.id;
  const userId = data.public_user_data.user_id;

  const scopeId = await resolveScopeId(clerkOrgId);
  if (!scopeId) {
    log.debug("No scope found for Clerk org, skipping", { clerkOrgId });
    return;
  }

  await globalThis.services.db
    .delete(scopeMembers)
    .where(
      and(eq(scopeMembers.scopeId, scopeId), eq(scopeMembers.userId, userId)),
    );

  log.debug("Membership deleted", { scopeId, userId });
}
