// eslint-disable-next-line web/no-direct-db-in-tests -- Test helper: service access needed for test data setup
import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
  updateUserPreferences,
} from "../../lib/zero/user/user-preferences-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Test helper: service access needed for test data setup
import { getVm0ApiKey } from "../../lib/zero/vm0-key/vm0-key-service";
import { insertTestPushSubscription } from "../db-test-seeders/users";
import { randomUUID } from "crypto";
import { getTestAuthContext } from "./core";

// Re-exports: DB-direct seeders
export {
  insertTestUser,
  seedUserCacheEntry,
  insertUserCacheEntry,
  insertVm0ApiKeys,
  deleteInsertedVm0ApiKeys,
} from "../db-test-seeders/users";
export { insertTestVoiceChatSession } from "../db-test-seeders/voice-chat";

// Re-exports: read-only assertions
export {
  countUserRows,
  getPushSubscriptionsByEndpoint,
} from "../db-test-assertions/users";
export {
  getTestVoiceChatSession,
  countTestVoiceChatSessionsByReasoningStatus,
} from "../db-test-assertions/voice-chat";

/**
 * Get a VM0 API key from the pool for a vendor.
 */
export async function getTestVm0ApiKey(vendor: string, model?: string) {
  return getVm0ApiKey(vendor, model);
}

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

/**
 * Atomically consume one network body capture quota for testing.
 * Wraps consumeCaptureNetworkBodies from user-preferences-service.
 */
export async function consumeTestCaptureNetworkBodies(
  orgId: string,
  userId: string,
): Promise<boolean> {
  return consumeCaptureNetworkBodies(orgId, userId);
}

/**
 * Get the full user preferences object for test setup. The caller must be
 * authenticated via mockClerk() before calling this function.
 */
export async function getTestUserPreferencesAll(): Promise<{
  timezone: string | null;
  pinnedAgentIds: string[];
  sendMode: string;
  captureNetworkBodiesRemaining: number;
}> {
  const { orgId, userId } = await getTestAuthContext();
  return getUserPreferences(orgId, userId);
}

/**
 * Update user preferences for test setup. The caller must be authenticated via
 * mockClerk() before calling this function.
 */
export async function updateTestUserPreferencesAll(prefs: {
  timezone?: string;
  pinnedAgentIds?: string[];
  sendMode?: "enter" | "cmd-enter";
  captureNetworkBodiesRemaining?: number;
}): Promise<{
  timezone: string | null;
  pinnedAgentIds: string[];
  sendMode: string;
  captureNetworkBodiesRemaining: number;
}> {
  const { orgId, userId } = await getTestAuthContext();
  return updateUserPreferences(orgId, userId, prefs);
}
