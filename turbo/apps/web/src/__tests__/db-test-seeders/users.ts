import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { users } from "../../db/schema/user";
import { userCache } from "../../db/schema/user-cache";
import { vm0ApiKeys } from "../../db/schema/vm0-api-key";

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
 * Insert a user row for testing.
 * @why-db-direct Bootstraps user record with emailUnsubscribed flag; no user-creation API exists for tests
 */
export async function insertUserRow(
  userId: string,
  emailUnsubscribed: boolean,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(users)
    .values({ id: userId, emailUnsubscribed })
    .onConflictDoNothing();
}

/**
 * Delete a user row by userId.
 * @why-db-direct No API route exists for deleting from the users table
 */
export async function deleteUserRow(userId: string): Promise<void> {
  initServices();
  await globalThis.services.db.delete(users).where(eq(users.id, userId));
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
 * Insert test VM0 API keys into the key pool.
 * @why-db-direct VM0 API key pool has no user-facing API; keys must be seeded directly
 */
export async function insertVm0ApiKeys(
  keys: Array<{
    vendor: string;
    model: string;
    apiKey: string;
    label?: string;
  }>,
) {
  initServices();
  await globalThis.services.db.insert(vm0ApiKeys).values(keys);
}
