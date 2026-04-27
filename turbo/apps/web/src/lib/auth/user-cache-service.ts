import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { userCache } from "@vm0/db/schema/user-cache";
import { logger } from "../shared/logger";

const log = logger("service:user-cache");

/** Cache TTL for user data (15 minutes) */
const CACHE_TTL_MS = 900_000;

interface CachedUser {
  userId: string;
  email: string;
  name: string | null;
}

/**
 * Get user data from cache or Clerk API.
 *
 * 1. Check user_cache by userId
 * 2. If fresh (< 15 min): return cached data
 * 3. If miss or stale: call Clerk API, upsert cache, return
 */
export async function getCachedUser(userId: string): Promise<CachedUser> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select()
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { userId, email: cached.email, name: cached.name };
  }

  // 2. Fetch from Clerk (source of truth)
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const primaryEmail = user.emailAddresses.find((e) => {
    return e.id === user.primaryEmailAddressId;
  });

  if (!primaryEmail?.emailAddress) {
    throw new Error(`No primary email found for user ${userId}`);
  }

  const email = primaryEmail.emailAddress;
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || null;

  // 3. Upsert cache
  const now = new Date();
  await db
    .insert(userCache)
    .values({ userId, email, name, cachedAt: now })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email, name, cachedAt: now },
    });

  log.debug("user cache refreshed", { userId });

  return { userId, email, name };
}

/**
 * Look up a user ID by email address, using cache when available.
 *
 * 1. Check user_cache by email column
 * 2. If fresh: return userId
 * 3. If miss: call Clerk API, upsert cache, return
 */
export async function getCachedUserIdByEmail(
  email: string,
): Promise<string | null> {
  const db = globalThis.services.db;

  // 1. Check cache (reverse lookup by email)
  const [cached] = await db
    .select()
    .from(userCache)
    .where(eq(userCache.email, email))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return cached.userId;
  }

  // 2. Fetch from Clerk (source of truth)
  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];

  if (!user) {
    return null;
  }

  // Resolve the canonical email: prefer primary email from user object,
  // fall back to the query email (which Clerk already matched)
  const resolvedEmail =
    user.emailAddresses?.find((e) => {
      return e.id === user.primaryEmailAddressId;
    })?.emailAddress ?? email;

  // 3. Upsert cache
  const now = new Date();
  await db
    .insert(userCache)
    .values({
      userId: user.id,
      email: resolvedEmail,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email: resolvedEmail, cachedAt: now },
    });

  log.debug("user cache refreshed via email lookup", { userId: user.id });

  return user.id;
}
