import { eq } from "drizzle-orm";
import { resendContactMapping } from "../../db/schema/resend-contact-mapping";
import { resendContactOutbox } from "../../db/schema/resend-contact-outbox";
import { initServices } from "../../lib/init-services";

/**
 * Find the Resend contact mapping for a given Clerk user id.
 */
export async function findTestContactMapping(clerkUserId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(resendContactMapping)
    .where(eq(resendContactMapping.clerkUserId, clerkUserId))
    .limit(1);
  return row ?? null;
}

/**
 * Find contact outbox rows matching a given Clerk user id.
 */
export async function findTestContactOutboxByClerkUserId(clerkUserId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(resendContactOutbox)
    .where(eq(resendContactOutbox.clerkUserId, clerkUserId));
}

/**
 * Find a contact outbox row by id.
 */
export async function findTestContactOutboxById(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(resendContactOutbox)
    .where(eq(resendContactOutbox.id, id))
    .limit(1);
  return row ?? null;
}
