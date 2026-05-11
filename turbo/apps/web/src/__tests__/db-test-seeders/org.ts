import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { ORG_SENTINEL_USER_ID } from "../../lib/zero/org/org-sentinel";
import { getTestAuthContext } from "../api-test-helpers/core";
import { ensureOrgRow } from "../test-helpers";

/**
 * Create a test org by inserting into org_cache.
 *
 * Pre-populates org_cache so getOrgNameAndSlug() works without Clerk API calls.
 *
 * @why-db-direct Simulates org creation with pre-populated cache;
 * Clerk webhook simulation not available in test infra
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
 * Delete an org row from the `org` table.
 * Useful for testing scenarios where the org row does not exist.
 *
 * @why-db-direct Deletes org row to test missing-org scenarios;
 * no API for org deletion (Clerk webhook handles this)
 */
export async function deleteOrgRow(orgId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Update the tier for an org in the `org` table.
 *
 * @why-db-direct Sets arbitrary tier; no API for direct tier changes
 * (Stripe webhook handles this)
 */
export async function updateOrgTier(
  orgId: string,
  tier: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ tier, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Update the default_agent_id (zero agent UUID) for an org in org_metadata.
 *
 * @why-db-direct Sets default agent ID directly; no API for this
 * (compose creation sets it as side effect)
 */
export async function updateOrgDefaultAgent(
  orgId: string,
  agentId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ defaultAgentId: agentId, updatedAt: new Date() })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Set the org's default agent by compose ID.
 * Resolves compose -> zero_agent via (orgId, name) and sets default_agent_id.
 *
 * @why-db-direct Resolves compose->agent and sets default;
 * no single API for this
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
 * Delete an org_cache row by orgId.
 * Useful for testing cache-miss behavior after createTestOrg pre-populates cache.
 *
 * @why-db-direct Deletes cache to test cache-miss behavior;
 * no API for cache deletion
 */
export async function deleteOrgCacheEntry(orgId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(orgCache)
    .where(eq(orgCache.orgId, orgId));
}

/**
 * Insert an org_members entry for testing member preferences.
 *
 * @why-db-direct Inserts member metadata with specific fields;
 * no API for bulk member metadata creation
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
 * Insert an org-level default model provider directly in the database.
 * Useful for testing credit check behavior with different provider types.
 *
 * Mirrors production `setModelProviderDefault` semantics — clears any existing
 * `isDefault=true` row for the same `(orgId, ORG_SENTINEL_USER_ID)` before
 * inserting, so the partial unique index
 * `idx_model_providers_one_default_per_user` is never violated when tests
 * stack multiple defaults during setup.
 *
 * @why-db-direct Inserts org-level provider bypassing API validation;
 * tests credit check with specific provider types
 */
export async function insertOrgDefaultModelProvider(
  orgId: string,
  type: string,
  selectedModel?: string,
): Promise<string> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const [row] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId: ORG_SENTINEL_USER_ID,
      orgId,
      isDefault: true,
      selectedModel: selectedModel ?? null,
    })
    .returning({ id: modelProviders.id });
  if (!row) throw new Error("insertOrgDefaultModelProvider: insert failed");
  return row.id;
}

/**
 * Insert an org-level multi-auth model provider (e.g., codex-oauth-token,
 * aws-bedrock) directly in the database with the given authMethod.
 *
 * Companion to `insertOrgDefaultModelProvider` for tests that need to
 * exercise the multi-auth resolver path. Production multi-auth providers
 * are created via `upsertMultiAuthModelProvider`, which requires a full
 * web request flow; this helper bypasses that for unit-style tests of
 * downstream resolution.
 *
 * @why-db-direct Multi-auth provider creation API requires a full web
 * request; tests need a direct insert with a specific authMethod set.
 */
export async function insertOrgMultiAuthModelProvider(
  orgId: string,
  type: string,
  authMethod: string,
  selectedModel?: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  await globalThis.services.db.insert(modelProviders).values({
    type,
    userId: ORG_SENTINEL_USER_ID,
    orgId,
    isDefault: true,
    authMethod,
    selectedModel: selectedModel ?? null,
  });
}

/**
 * Insert an org-level non-default model provider directly in the database.
 *
 * Companion to `insertOrgDefaultModelProvider` for tests that need to seed
 * a coexisting provider row that the workspace's single-default invariant
 * (#11743) precludes from being marked default. Used by resolver tests that
 * exercise the explicit-modelProvider override path: the request's
 * `modelProvider` differs from the workspace default's type and the resolver
 * must look up the explicit row by type to surface its `selectedModel` /
 * `authMethod`.
 *
 * @why-db-direct Tests need a non-default org-level provider; the public
 * `setup` API marks the inserted row as default when none exists.
 */
export async function insertOrgNonDefaultModelProvider(
  orgId: string,
  type: string,
  selectedModel?: string,
): Promise<void> {
  initServices();
  await globalThis.services.db.insert(modelProviders).values({
    type,
    userId: ORG_SENTINEL_USER_ID,
    orgId,
    isDefault: false,
    selectedModel: selectedModel ?? null,
  });
}

/**
 * Delete a model provider row by id. Used by tests that need to simulate
 * a provider deletion after rows referencing it (e.g. chat threads with an
 * eager-pinned modelProviderId) have already been created.
 *
 * @why-db-direct The provider deletion API is type-scoped; tests need an
 * id-scoped deleter to set up orphan-pin scenarios deterministically.
 */
export async function deleteTestModelProvider(
  providerId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(modelProviders)
    .where(eq(modelProviders.id, providerId));
}

/**
 * Set the credit balance for an org in the `org` table.
 * Ensures the org row exists first.
 *
 * Authoritative on intent — when a test says "give this org exactly N
 * credits", this helper does NOT create a matching credit_expires_record.
 * Tests that exercise FEFO or the 1-month expiry should seed an expires
 * row explicitly via createExpiresRecord / ensureStarterCreditGrant.
 *
 * @why-db-direct Sets credit balance directly; no API for direct
 * credit manipulation (Stripe webhook handles this)
 */
export async function setOrgCredits(
  orgId: string,
  credits: number,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId, credits })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { credits, updatedAt: new Date() },
    });
}

/**
 * Hold a row lock on org_metadata, update credits, and keep the transaction
 * open until the returned release function is called.
 *
 * @why-db-direct Exercises lock-ordering race conditions in service tests;
 * no API route can hold a row lock open for coordinated concurrency.
 */
export async function lockOrgAndSetCredits(
  orgId: string,
  credits: number,
): Promise<{
  release: () => void;
  ready: Promise<void>;
  done: Promise<void>;
}> {
  initServices();

  let release!: () => void;
  const releaseSignal = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const done = globalThis.services.db.transaction(async (tx) => {
    await tx
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .for("update");

    await tx
      .update(orgMetadata)
      .set({ credits, updatedAt: new Date() })
      .where(eq(orgMetadata.orgId, orgId));

    markReady();
    await releaseSignal;
  });

  return { release, ready, done };
}

// ============================================================================
// User-Level (BYOK) Model Provider Seeders — Epic #11868
// ============================================================================

/**
 * Insert a user-level (personal) default model provider directly in the
 * database. Personal default is workspace-scoped per (orgId, userId), so it
 * coexists with the org default — paired with the partial unique index
 * `idx_model_providers_one_default_per_user`. Mirrors the org seeder's
 * "clear existing default for the same scope first" semantics.
 *
 * @why-db-direct Inserts user-tier provider bypassing API validation;
 * resolver tests need to seed personal-tier rows without secrets routing
 * through the public upsert flow.
 */
export async function insertUserDefaultModelProvider(
  orgId: string,
  userId: string,
  type: string,
  selectedModel?: string,
): Promise<string> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.isDefault, true),
      ),
    );
  const [row] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      orgId,
      isDefault: true,
      selectedModel: selectedModel ?? null,
    })
    .returning({ id: modelProviders.id });
  if (!row) throw new Error("insertUserDefaultModelProvider: insert failed");
  return row.id;
}

export async function insertUserMultiAuthModelProvider(
  orgId: string,
  userId: string,
  type: string,
  authMethod: string,
  selectedModel?: string,
): Promise<string> {
  initServices();
  await globalThis.services.db
    .update(modelProviders)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.isDefault, true),
      ),
    );
  const [row] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      orgId,
      isDefault: true,
      authMethod,
      selectedModel: selectedModel ?? null,
    })
    .returning({ id: modelProviders.id });
  if (!row) throw new Error("insertUserMultiAuthModelProvider: insert failed");
  return row.id;
}

/**
 * Insert a user-level non-default model provider directly in the database.
 * Companion to `insertUserDefaultModelProvider` for tests that need to seed
 * a coexisting personal-tier row that the workspace's single-default
 * invariant precludes from being marked default.
 *
 * @why-db-direct Tests need a non-default user-level provider without changing
 * the existing user default.
 */
export async function insertUserNonDefaultModelProvider(
  orgId: string,
  userId: string,
  type: string,
  selectedModel?: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      orgId,
      isDefault: false,
      selectedModel: selectedModel ?? null,
    })
    .returning({ id: modelProviders.id });
  if (!row) throw new Error("insertUserNonDefaultModelProvider: insert failed");
  return row.id;
}

/**
 * Enable the `modelFirstModelProvider` feature switch for a specific user.
 *
 * @why-db-direct Tests need deterministic feature switch state without
 *   relying on static rollout rules.
 */
export async function enableModelFirstModelProviderForUser(
  orgId: string,
  userId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: { modelFirstModelProvider: true },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: { modelFirstModelProvider: true },
        updatedAt: new Date(),
      },
    });
}

export async function insertOrgModelPolicy(params: {
  orgId: string;
  model: string;
  isDefault?: boolean;
  defaultProviderType?: string;
  credentialScope?: string;
  modelProviderId?: string | null;
}): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(orgModelPolicies)
    .values({
      orgId: params.orgId,
      model: params.model,
      isDefault: params.isDefault ?? false,
      defaultProviderType: params.defaultProviderType ?? "vm0",
      credentialScope: params.credentialScope ?? "org",
      modelProviderId: params.modelProviderId ?? null,
    })
    .returning({ id: orgModelPolicies.id });
  if (!row) throw new Error("insertOrgModelPolicy: insert failed");
  return row.id;
}

export async function insertUserModelPreference(params: {
  orgId: string;
  userId: string;
  model: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMembersMetadata)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: params.model,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel: params.model,
        updatedAt: new Date(),
      },
    });
}
