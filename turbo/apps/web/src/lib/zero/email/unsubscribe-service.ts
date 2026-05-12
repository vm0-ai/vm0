import { users } from "@vm0/db/schema/user";

/**
 * Unsubscribe a user from system-initiated emails.
 * Sets `email_unsubscribed = true` in the users table (upserts if row missing).
 */
export async function unsubscribeUser(userId: string): Promise<void> {
  await globalThis.services.db
    .insert(users)
    .values({ id: userId, emailUnsubscribed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { emailUnsubscribed: true, updatedAt: new Date() },
    });
}
