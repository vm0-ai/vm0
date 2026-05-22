import { pushSubscriptions } from "@vm0/db/schema/push-subscription";
import { users } from "@vm0/db/schema/user";
import { userCache } from "@vm0/db/schema/user-cache";

/**
 * Insert a user row for testing.
 * Uses onConflictDoNothing so it's safe to call multiple times.
 * @why-db-direct Bootstraps minimal user record; no user-creation API exists for tests
 */
export async function insertTestUser(userId: string): Promise<void> {
  await globalThis.services.db
    .insert(users)
    .values({ id: userId })
    .onConflictDoNothing();
}

/**
 * Seed or update a user_cache entry for testing.
 * @why-db-direct Upserts user_cache entries to set up test user identity without Clerk API
 */
export async function seedUserCacheEntry(
  userId: string,
  email: string,
  name?: string,
): Promise<void> {
  await globalThis.services.db
    .insert(userCache)
    .values({ userId, email, name: name ?? null, cachedAt: new Date() })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email, name: name ?? null, cachedAt: new Date() },
    });
}

/**
 * Insert a user_cache row for testing.
 * @why-db-direct Injects cache entries with specific timestamps for cache behavior testing
 */
export async function insertUserCacheEntry(entry: {
  userId: string;
  email: string;
  name?: string;
  cachedAt?: Date;
}): Promise<void> {
  await globalThis.services.db.insert(userCache).values({
    userId: entry.userId,
    email: entry.email,
    name: entry.name ?? null,
    cachedAt: entry.cachedAt ?? new Date(),
  });
}

/**
 * Insert or update a push subscription for testing.
 * @why-db-direct Push subscriptions are now API-backend authoritative; web callback tests seed the DB fixture directly
 */
export async function insertTestPushSubscription(args: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<void> {
  await globalThis.services.db
    .insert(pushSubscriptions)
    .values(args)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: args.userId,
        p256dh: args.p256dh,
        auth: args.auth,
      },
    });
}
