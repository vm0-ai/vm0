import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { orgCache } from "../../db/schema/org-cache";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { zeroAgents } from "../../db/schema/zero-agent";
import { agentComposes } from "../../db/schema/agent-compose";
import { modelProviders } from "../../db/schema/model-provider";
import { ORG_SENTINEL_USER_ID } from "../../lib/zero/org/org-sentinel";
import { getTestAuthContext } from "./core";

/**
 * Create a test org by inserting into org_cache.
 *
 * Pre-populates org_cache so getOrgNameAndSlug() works without Clerk API calls.
 *
 * @param slug - The org slug
 * @returns The created org with id and slug
 */
export async function createTestOrg(
  slug: string,
): Promise<{ id: string; slug: string }> {
  initServices();

  // Use the mock Clerk orgId pattern from clerk-mock.ts
  const { orgId } = await getTestAuthContext();

  // Pre-populate org_cache so getOrgNameAndSlug() works without Clerk API calls
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug,
      name: slug,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, name: slug, cachedAt: new Date() },
    });

  // Ensure org row exists (source of truth for tier and default agent)
  await ensureOrgRow(orgId);

  return { id: orgId, slug };
}

/**
 * Ensure an org row exists in the `org` table.
 * Inserts with defaults if missing, does nothing if already present.
 */
export async function ensureOrgRow(orgId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId })
    .onConflictDoNothing();
}

/**
 * Delete an org row from the `org` table.
 * Useful for testing scenarios where the org row does not exist.
 */
export async function deleteOrgRow(orgId: string): Promise<void> {
  await globalThis.services.db
    .delete(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Update the tier for an org in the `org` table.
 */
export async function updateOrgTier(
  orgId: string,
  tier: string,
): Promise<void> {
  await globalThis.services.db
    .update(orgMetadata)
    .set({ tier, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Read the default agent ID (zero agent UUID) for an org from org_metadata.
 */
export async function getOrgDefaultAgent(
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.defaultAgentId ?? null;
}

/**
 * Update the default_agent_id (zero agent UUID) for an org in org_metadata.
 */
export async function updateOrgDefaultAgent(
  orgId: string,
  agentId: string,
): Promise<void> {
  await globalThis.services.db
    .update(orgMetadata)
    .set({ defaultAgentId: agentId, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Set the org's default agent by compose ID.
 * Resolves compose → zero_agent via (orgId, name) and sets default_agent_id.
 */
export async function setDefaultAgentByComposeId(
  orgId: string,
  composeId: string,
): Promise<void> {
  initServices();
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!compose) throw new Error(`Compose not found: ${composeId}`);

  const [agent] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, compose.name)))
    .limit(1);
  if (!agent) throw new Error(`Zero agent not found for compose: ${composeId}`);

  await globalThis.services.db
    .update(orgMetadata)
    .set({ defaultAgentId: agent.id, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Insert a row into org_cache for testing cache behavior.
 */
export async function insertOrgCacheEntry(entry: {
  orgId: string;
  slug: string;
  name?: string;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId: entry.orgId,
      slug: entry.slug,
      name: entry.name ?? entry.slug,
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: entry.slug,
        name: entry.name ?? entry.slug,
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

/**
 * Delete an org_cache row by orgId.
 * Useful for testing cache-miss behavior after createTestOrg pre-populates cache.
 */
export async function deleteOrgCacheEntry(orgId: string): Promise<void> {
  await globalThis.services.db
    .delete(orgCache)
    .where(eq(orgCache.orgId, orgId));
}

/**
 * Read an org_cache row by orgId.
 */
export async function getOrgCacheEntry(orgId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * Insert an org_members_cache entry for testing cache behavior.
 */
export async function insertOrgMembersCacheEntry(entry: {
  orgId: string;
  userId: string;
  role?: string;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId: entry.orgId,
      userId: entry.userId,
      role: entry.role ?? "member",
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        role: entry.role ?? "member",
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

export async function findOrgMembersCacheEntry(orgId: string, userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  return row;
}

/**
 * Delete a cached membership entry. Useful for tests that need to change
 * a user's role mid-test (the cache would otherwise serve the stale role).
 */
export async function clearOrgMembersCacheEntry(
  orgId: string,
  userId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    );
}

/**
 * Insert an org_members entry for testing member preferences.
 */
export async function insertOrgMembersEntry(entry: {
  orgId: string;
  userId: string;
  timezone?: string | null;
  pinnedAgentIds?: string[];
  sendMode?: string;
  onboardingDone?: boolean;
  creditCap?: number | null;
  creditEnabled?: boolean;
}): Promise<void> {
  initServices();
  const now = new Date();
  await globalThis.services.db
    .insert(orgMembersMetadata)
    .values({
      orgId: entry.orgId,
      userId: entry.userId,
      timezone: entry.timezone ?? null,
      pinnedAgentIds: entry.pinnedAgentIds ?? [],
      sendMode: entry.sendMode ?? "enter",
      onboardingDone: entry.onboardingDone ?? false,
      creditCap: entry.creditCap ?? null,
      creditEnabled: entry.creditEnabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(entry.timezone !== undefined && { timezone: entry.timezone }),
        ...(entry.pinnedAgentIds !== undefined && {
          pinnedAgentIds: entry.pinnedAgentIds,
        }),
        ...(entry.sendMode !== undefined && { sendMode: entry.sendMode }),
        ...(entry.onboardingDone !== undefined && {
          onboardingDone: entry.onboardingDone,
        }),
        ...(entry.creditCap !== undefined && { creditCap: entry.creditCap }),
        ...(entry.creditEnabled !== undefined && {
          creditEnabled: entry.creditEnabled,
        }),
        updatedAt: now,
      },
    });
}

/**
 * Return the Drizzle DB instance from globalThis.services.
 * Useful for passing to script functions under test that need a db parameter.
 */
export function getTestDb() {
  initServices();
  return globalThis.services.db;
}

/**
 * Read a full org_metadata row by orgId.
 * Returns undefined if no row exists.
 */
export async function getOrgRow(orgId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row;
}

/**
 * Read a full org_members_metadata row by (orgId, userId).
 * Returns undefined if no row exists.
 */
export async function getOrgMembersEntry(orgId: string, userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  return row;
}

/**
 * Delete an org_members_metadata row by (orgId, userId).
 */
export async function deleteOrgMembersEntry(
  orgId: string,
  userId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
}

/** Count rows by org_id in a given table using raw SQL to avoid type casts. */
export async function countOrgRows(
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
    | "zero_agents"
    | "zero_agent_schedules"
    | "credit_usage"
    | "agent_sessions"
    | "email_thread_sessions"
    | "slack_org_installations"
    | "org_members_cache"
    | "org_members_metadata"
    | "org_cache"
    | "org_metadata",
  orgId: string,
): Promise<number> {
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM ${sql.identifier(tableName)} WHERE org_id = ${orgId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

/**
 * Insert an org-level default model provider directly in the database.
 * Useful for testing credit check behavior with different provider types.
 */
export async function insertOrgDefaultModelProvider(
  orgId: string,
  type: string,
  selectedModel?: string,
): Promise<void> {
  await globalThis.services.db.insert(modelProviders).values({
    type,
    userId: ORG_SENTINEL_USER_ID,
    orgId,
    isDefault: true,
    selectedModel: selectedModel ?? null,
  });
}

/**
 * Read the credit balance for an org from the `org` table.
 * Returns null if no row exists.
 */
export async function getOrgCredits(orgId: string): Promise<number | null> {
  const [row] = await globalThis.services.db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.credits ?? null;
}

/**
 * Set the credit balance for an org in the `org` table.
 * Ensures the org row exists first.
 */
export async function setOrgCredits(
  orgId: string,
  credits: number,
): Promise<void> {
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId, credits })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { credits, updatedAt: new Date() },
    });
}

// Sentinel for orgId used in org-sentinel pattern
export { ORG_SENTINEL_USER_ID } from "../../lib/zero/org/org-sentinel";
