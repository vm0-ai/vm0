import { initServices } from "../../lib/init-services";
import { users } from "../../db/schema/user";
import { userCache } from "../../db/schema/user-cache";
import { vm0ApiKeys } from "../../db/schema/vm0-api-key";
import {
  voiceChatSessions,
  voiceChatPreparations,
} from "../../db/schema/voice-chat";

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

/**
 * Create a voice-chat session directly in the database.
 * @why-db-direct Voice chat sessions are created by the voice-chat API which requires WebSocket infrastructure not available in tests
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

/**
 * Insert a voice-chat session with full override support.
 * @why-db-direct Voice chat sessions require WebSocket infrastructure; full override enables impossible-state testing (e.g., stale heartbeats)
 */
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

/**
 * Insert a voice-chat preparation record.
 * @why-db-direct Voice chat preparations are created by the prepare endpoint which requires real-time infrastructure
 */
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
