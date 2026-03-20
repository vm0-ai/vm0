import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { users } from "../../db/schema/user";
import { logger } from "../logger";

const log = logger("service:unsubscribe");

/**
 * Check if a user has unsubscribed from system-initiated emails.
 * Reads `email_unsubscribed` from the users table.
 *
 * // TODO(#5514): remove this fallback after full backfill
 * Falls back to Clerk publicMetadata if DB says false/missing,
 * and lazy-migrates the value to DB on first access.
 */
export async function isUserUnsubscribed(userId: string): Promise<boolean> {
  const [row] = await globalThis.services.db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (row?.emailUnsubscribed) {
    return true;
  }

  // TODO(#5514): remove this fallback after full backfill
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(userId);
  const clerkValue =
    (clerkUser.publicMetadata as Record<string, unknown> | undefined)
      ?.email_unsubscribed === true;

  if (clerkValue) {
    log.info("lazy migration: email_unsubscribed from Clerk", { userId });
    await globalThis.services.db
      .insert(users)
      .values({ id: userId, emailUnsubscribed: true })
      .onConflictDoUpdate({
        target: users.id,
        set: { emailUnsubscribed: true, updatedAt: new Date() },
      })
      .catch((err: unknown) =>
        log.warn("lazy migration: email_unsubscribed write failed", {
          userId,
          err,
        }),
      );
    return true;
  }

  return false;
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
