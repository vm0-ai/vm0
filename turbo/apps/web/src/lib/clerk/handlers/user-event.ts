import { eq } from "drizzle-orm";
import { scopeMembers } from "../../../db/schema/scope-member";
import { logger } from "../../logger";
import type { WebhookEvent } from "@clerk/nextjs/server";

const log = logger("webhook:clerk:user");

type UserDeletedEvent = Extract<WebhookEvent, { type: "user.deleted" }>;

/**
 * Handle user.deleted — clean up all scope_members records for the deleted user.
 *
 * This is a safety net for when a Clerk Dashboard admin manually deletes a user.
 * Self-service account deletion is disabled in the Dashboard.
 */
export async function handleUserDeleted(data: UserDeletedEvent["data"]) {
  const userId = data.id;
  if (!userId) {
    log.warn("user.deleted event missing user ID, skipping");
    return;
  }

  const deleted = await globalThis.services.db
    .delete(scopeMembers)
    .where(eq(scopeMembers.userId, userId))
    .returning({ id: scopeMembers.id });

  log.info("User deleted, cleaned up scope memberships", {
    userId,
    removedCount: deleted.length,
  });
}
