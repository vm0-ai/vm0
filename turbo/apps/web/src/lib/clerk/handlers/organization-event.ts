import { eq } from "drizzle-orm";
import { scopes } from "../../../db/schema/scope";
import { scopeMembers } from "../../../db/schema/scope-member";
import { logger } from "../../logger";
import type { WebhookEvent } from "@clerk/nextjs/server";

const log = logger("webhook:clerk:organization");

type OrgDeletedEvent = Extract<WebhookEvent, { type: "organization.deleted" }>;

/**
 * Handle organization.deleted — clean up the corresponding scope.
 *
 * This is a safety net for when a Clerk Dashboard admin manually deletes an org.
 * Organization deletion is disabled for users in the Dashboard.
 */
export async function handleOrganizationDeleted(data: OrgDeletedEvent["data"]) {
  const clerkOrgId = data.id;
  if (!clerkOrgId) {
    log.warn("organization.deleted event missing org ID, skipping");
    return;
  }

  const [scope] = await globalThis.services.db
    .select({ id: scopes.id, slug: scopes.slug })
    .from(scopes)
    .where(eq(scopes.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!scope) {
    log.debug("No scope found for deleted Clerk org, skipping", {
      clerkOrgId,
    });
    return;
  }

  // Clean up scope members
  const deleted = await globalThis.services.db
    .delete(scopeMembers)
    .where(eq(scopeMembers.scopeId, scope.id))
    .returning({ id: scopeMembers.id });

  // Mark scope as orphaned by updating clerk_org_id to a sentinel
  await globalThis.services.db
    .update(scopes)
    .set({
      clerkOrgId: `deleted_${clerkOrgId}`,
      updatedAt: new Date(),
    })
    .where(eq(scopes.id, scope.id));

  log.warn("Organization deleted, scope orphaned", {
    clerkOrgId,
    scopeId: scope.id,
    scopeSlug: scope.slug,
    removedMembers: deleted.length,
  });
}
