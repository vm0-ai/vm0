import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
  updateUserPreferences,
} from "../../lib/zero/user/user-preferences-service";
import { pushSubscriptions } from "../../db/schema/push-subscription";
import {
  voiceChatSessions,
  voiceChatEvents,
  voiceChatPreparations,
} from "../../db/schema/voice-chat";
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
} from "../db-test-seeders/users";

// Re-exports: read-only assertions
export { getUserRow, countUserRows } from "../db-test-assertions/users";

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
 * Query push subscriptions for the given endpoint directly from the DB.
 * Returns the matching rows (empty array means the subscription was deleted).
 */
export async function getPushSubscriptionsByEndpoint(
  endpoint: string,
): Promise<Array<{ id: string; endpoint: string }>> {
  initServices();
  return globalThis.services.db
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
}

// ============================================================================
// Voice Chat Helpers
// ============================================================================

/**
 * Create a voice-chat session directly in the database.
 */
export async function createTestVoiceChatSession(
  orgId: string,
  userId: string,
  status = "active",
): Promise<{ id: string }> {
  initServices();
  const [session] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({ orgId, userId, status })
    .returning({ id: voiceChatSessions.id });
  return session!;
}

export async function insertTestVoiceChatSession(overrides: {
  orgId: string;
  userId: string;
  agentId?: string;
  status?: string;
  runId?: string;
  createdAt?: Date;
  lastHeartbeatAt?: Date;
}): Promise<string> {
  initServices();
  const now = new Date();
  const [row] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      agentId: overrides.agentId,
      status: overrides.status ?? "active",
      runId: overrides.runId,
      createdAt: overrides.createdAt ?? now,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
    })
    .returning({ id: voiceChatSessions.id });
  return row!.id;
}

export async function getTestVoiceChatSessionStatus(
  id: string,
): Promise<string | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ status: voiceChatSessions.status })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row?.status;
}

export async function getTestVoiceChatSessionHeartbeat(
  id: string,
): Promise<Date | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ lastHeartbeatAt: voiceChatSessions.lastHeartbeatAt })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row?.lastHeartbeatAt;
}

export async function getTestVoiceChatEvents(
  sessionId: string,
): Promise<Array<{ type: string; source: string; content: string | null }>> {
  initServices();
  return globalThis.services.db
    .select({
      type: voiceChatEvents.type,
      source: voiceChatEvents.source,
      content: voiceChatEvents.content,
    })
    .from(voiceChatEvents)
    .where(eq(voiceChatEvents.sessionId, sessionId));
}

export async function insertTestVoiceChatPreparation(overrides: {
  orgId: string;
  userId: string;
  agentId?: string;
  mode?: string;
  prompt?: string;
  runId?: string;
  status?: string;
  directiveContent?: string;
  createdAt?: Date;
}): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(voiceChatPreparations)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      agentId: overrides.agentId,
      mode: overrides.mode ?? "chat",
      prompt: overrides.prompt ?? null,
      runId: overrides.runId ?? null,
      status: overrides.status ?? "preparing",
      directiveContent: overrides.directiveContent ?? null,
      createdAt: overrides.createdAt ?? new Date(),
    })
    .returning({ id: voiceChatPreparations.id });
  return row!.id;
}

export async function getTestVoiceChatPreparation(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(voiceChatPreparations)
    .where(eq(voiceChatPreparations.id, id))
    .limit(1);
  return row;
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
