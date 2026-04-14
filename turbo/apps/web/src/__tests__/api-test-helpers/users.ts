import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
  updateUserPreferences,
} from "../../lib/zero/user/user-preferences-service";
import { getVm0ApiKey } from "../../lib/zero/vm0-key/vm0-key-service";
import { POST as registerPushSubscriptionRoute } from "../../../app/api/zero/push-subscriptions/route";
import { randomUUID } from "crypto";
import { createTestRequest } from "./core";

// Re-exports: DB-direct seeders
export {
  insertTestUser,
  insertUserRow,
  deleteUserRow,
  seedUserCacheEntry,
  insertUserCacheEntry,
  insertVm0ApiKeys,
  createTestVoiceChatSession,
  insertTestVoiceChatSession,
  insertTestVoiceChatPreparation,
} from "../db-test-seeders/users";

// Re-exports: read-only assertions
export {
  getUserRow,
  countUserRows,
  getPushSubscriptionsByEndpoint,
  getTestVoiceChatSessionStatus,
  getTestVoiceChatSessionHeartbeat,
  getTestVoiceChatEvents,
  getTestVoiceChatPreparation,
} from "../db-test-assertions/users";

/**
 * Get a VM0 API key from the pool for a vendor.
 */
export async function getTestVm0ApiKey(vendor: string) {
  return getVm0ApiKey(vendor);
}

/**
 * Register a push subscription for the current authenticated user via the
 * POST /api/zero/push-subscriptions route. The user must already be
 * authenticated via mockClerk() before calling this function.
 */
export async function createTestPushSubscription(
  endpoint?: string,
): Promise<{ endpoint: string }> {
  const ep = endpoint ?? `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

  const response = await registerPushSubscriptionRoute(
    createTestRequest("http://localhost:3000/api/zero/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: ep,
        keys: {
          p256dh:
            "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI",
          auth: "tBHItJI5svbpC7hYyKw",
        },
      }),
    }),
  );

  if (response.status !== 201) {
    throw new Error(
      `Failed to register push subscription: status ${response.status}`,
    );
  }

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
 * Get the full user preferences object for testing.
 * Wraps getUserPreferences from user-preferences-service.
 */
export async function getTestUserPreferencesAll(
  orgId: string,
  userId: string,
): Promise<{
  timezone: string | null;
  pinnedAgentIds: string[];
  sendMode: string;
  captureNetworkBodiesRemaining: number;
}> {
  return getUserPreferences(orgId, userId);
}

/**
 * Update user preferences for test setup.
 * Wraps updateUserPreferences from user-preferences-service.
 */
export async function updateTestUserPreferencesAll(
  orgId: string,
  userId: string,
  prefs: {
    timezone?: string;
    pinnedAgentIds?: string[];
    sendMode?: "enter" | "cmd-enter";
    captureNetworkBodiesRemaining?: number;
  },
): Promise<{
  timezone: string | null;
  pinnedAgentIds: string[];
  sendMode: string;
  captureNetworkBodiesRemaining: number;
}> {
  return updateUserPreferences(orgId, userId, prefs);
}
