import { eq } from "drizzle-orm";
import { users } from "@vm0/db/schema/user";

/**
 * Check if a user has unsubscribed from system-initiated emails.
 * Reads `email_unsubscribed` from the users table.
 */
export async function isUserUnsubscribed(userId: string): Promise<boolean> {
  const [row] = await globalThis.services.db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.emailUnsubscribed ?? false;
}

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
