import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  consumeCaptureNetworkBodies,
  getUserPreferences,
  updateUserPreferences,
} from "../../lib/zero/user/user-preferences-service";
import { users } from "../../db/schema/user";
import { userCache } from "../../db/schema/user-cache";
import { vm0ApiKeys } from "../../db/schema/vm0-api-key";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
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

/**
 * Read a full users row by userId.
 * Returns undefined if no row exists.
 */
export async function getUserRow(userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

/**
 * Insert a user row for testing.
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
 */
export async function deleteUserRow(userId: string): Promise<void> {
  initServices();
  await globalThis.services.db.delete(users).where(eq(users.id, userId));
}

/**
 * Insert a user row for testing.
 * Uses onConflictDoNothing so it's safe to call multiple times.
 */
export async function insertTestUser(userId: string): Promise<void> {
  await globalThis.services.db
    .insert(users)
    .values({ id: userId })
    .onConflictDoNothing();
}

/**
 * Insert test VM0 API keys into the key pool.
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

/**
 * Get a VM0 API key from the pool for a vendor.
 */
export async function getTestVm0ApiKey(vendor: string) {
  return getVm0ApiKey(vendor);
}

/**
 * Seed or update a user_cache entry for testing.
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
 * Count rows in a table where user_id matches.
 * Mirror of countOrgRows for user-scoped deletion verification.
 */
export async function countUserRows(
  tableName:
    | "agent_runs"
    | "agent_run_queue"
    | "agent_composes"
    | "storages"
    | "secrets"
    | "model_providers"
    | "connectors"
    | "variables"
    | "usage_daily"
    | "export_jobs"
    | "zero_agent_schedules"
    | "cli_tokens"
    | "compose_jobs"
    | "connector_sessions"
    | "device_codes"
    | "org_members_cache"
    | "org_members_metadata"
    | "user_cache"
    | "users",
  userId: string,
): Promise<number> {
  const columnName = tableName === "users" ? "id" : "user_id";
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(columnName)} = ${userId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

/**
 * Get user preferences from org_members_metadata.
 */
export async function getTestUserPreferences(
  userId: string,
  orgId: string,
): Promise<{
  timezone: string | null;
  sendMode: string;
  onboardingDone: boolean;
}> {
  const [row] = await globalThis.services.db
    .select({
      timezone: orgMembersMetadata.timezone,
      sendMode: orgMembersMetadata.sendMode,
      onboardingDone: orgMembersMetadata.onboardingDone,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, userId),
        eq(orgMembersMetadata.orgId, orgId),
      ),
    )
    .limit(1);
  return {
    timezone: row?.timezone ?? null,
    sendMode: row?.sendMode ?? "enter",
    onboardingDone: row?.onboardingDone ?? false,
  };
}

/**
 * Set user preferences in org_members_metadata.
 */
export async function setTestUserPreferences(
  userId: string,
  orgId: string,
  prefs: Partial<{
    timezone: string | null;
    sendMode: string;
    onboardingDone: boolean;
  }>,
): Promise<void> {
  await globalThis.services.db
    .insert(orgMembersMetadata)
    .values({
      userId,
      orgId,
      timezone: prefs.timezone ?? null,
      sendMode: prefs.sendMode ?? "enter",
      onboardingDone: prefs.onboardingDone ?? false,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
        ...(prefs.sendMode !== undefined && { sendMode: prefs.sendMode }),
        ...(prefs.onboardingDone !== undefined && {
          onboardingDone: prefs.onboardingDone,
        }),
        updatedAt: new Date(),
      },
    });
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
