import { insertTestPushSubscription } from "../db-test-seeders/users";
import { randomUUID } from "crypto";
import { getTestAuthContext } from "./core";

// Re-exports: DB-direct seeders
export {
  insertTestUser,
  seedUserCacheEntry,
  insertUserCacheEntry,
} from "../db-test-seeders/users";

// Re-exports: read-only assertions
export {
  countUserRows,
  getPushSubscriptionsByEndpoint,
} from "../db-test-assertions/users";

/**
 * Register a push subscription for the current authenticated user. The user
 * must already be authenticated via mockClerk() before calling this function.
 */
export async function createTestPushSubscription(
  endpoint?: string,
): Promise<{ endpoint: string }> {
  const ep = endpoint ?? `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  const { userId } = await getTestAuthContext();
  const p256dh =
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI";
  const auth = "tBHItJI5svbpC7hYyKw";

  await insertTestPushSubscription({ userId, endpoint: ep, p256dh, auth });

  return { endpoint: ep };
}
