import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { chatThreads } from "@vm0/db/schema/chat-thread";

/**
 * Read the default agent ID (zero agent UUID) for an org from org_metadata.
 */
export async function getOrgDefaultAgent(
  orgId: string,
): Promise<string | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.defaultAgentId ?? null;
}

/**
 * Read an org_cache row by orgId.
 */
export async function getOrgCacheEntry(orgId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  return row ?? null;
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
 * Count rows by org_id in a given table using raw SQL to avoid type casts.
 */
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
    | "usage_event"
    | "export_jobs"
    | "zero_agents"
    | "zero_agent_schedules"
    | "agent_sessions"
    | "email_thread_sessions"
    | "slack_org_installations"
    | "org_members_cache"
    | "org_members_metadata"
    | "org_cache"
    | "org_metadata",
  orgId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM ${sql.identifier(tableName)} WHERE org_id = ${orgId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

/**
 * Read the credit balance for an org from the `org` table.
 * Returns null if no row exists.
 */
export async function getOrgCredits(orgId: string): Promise<number | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.credits ?? null;
}

/**
 * Read the OAuth token state columns from a model_providers row.
 * Used by firewall refresh tests to verify the refresh pipeline persisted
 * tokenExpiresAt / needsReconnect / lastRefreshErrorCode correctly.
 */
export async function findTestModelProviderTokenState(
  orgId: string,
  userId: string,
  type: string,
): Promise<{
  tokenExpiresAt: Date | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
  workspaceName: string | null;
  planType: string | null;
} | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      tokenExpiresAt: modelProviders.tokenExpiresAt,
      needsReconnect: modelProviders.needsReconnect,
      lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      workspaceName: modelProviders.workspaceName,
      planType: modelProviders.planType,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Set tokenExpiresAt on a model_providers row directly.
 * Used by firewall refresh tests to seed an "expired" state without
 * waiting for real time.
 */
export async function setTestModelProviderTokenExpiresAt(
  orgId: string,
  userId: string,
  type: string,
  tokenExpiresAt: Date | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ tokenExpiresAt })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    );
}

/**
 * Set the OAuth refresh-state columns on a model_providers row directly.
 * Used by Wave 3 stale-UX tests to seed a "needs reconnect" state without
 * triggering the firewall webhook flow.
 *
 * @why-db-direct The webhook handler is the only production path that flips
 * `needsReconnect`; tests that exercise downstream consumers (banner, runner
 * guard, API surface) need to seed this state directly.
 */
export async function setTestModelProviderNeedsReconnect(
  orgId: string,
  userId: string,
  type: string,
  needsReconnect: boolean,
  lastRefreshErrorCode: string | null = null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ needsReconnect, lastRefreshErrorCode })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    );
}

/**
 * Look up the uuid of a model provider by org + type. Useful for tests that
 * need to reference a provider they just seeded via insertOrgDefaultModelProvider.
 */
export async function getTestModelProviderIdByType(
  orgId: string,
  type: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(and(eq(modelProviders.orgId, orgId), eq(modelProviders.type, type)))
    .limit(1);
  if (!row) {
    throw new Error(`No model provider of type "${type}" for org ${orgId}`);
  }
  return row.id;
}

export async function findTestOrgModelProviderByType(
  orgId: string,
  type: string,
): Promise<{
  id: string;
  type: string;
  selectedModel: string | null;
} | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, "__org__"),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Read the per-thread selected model override written by the chat-messages send
 * route when the composer's picker is active. Provider IDs should remain null
 * because provider routing is re-resolved per run.
 */
export async function getTestChatThreadModelOverride(
  threadId: string,
): Promise<{
  modelProviderId: string | null;
  selectedModel: string | null;
}> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      modelProviderId: chatThreads.modelProviderId,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return {
    modelProviderId: row?.modelProviderId ?? null,
    selectedModel: row?.selectedModel ?? null,
  };
}

export async function getTestUserSelectedModel(
  orgId: string,
  userId: string,
): Promise<string | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return row?.selectedModel ?? null;
}
