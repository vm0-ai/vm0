import { eq, and, or, inArray } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  getFrameworkForType,
  getSecretNameForType,
  hasAuthMethods,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  getSecretNamesForAuthMethod,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { encryptSecretValue } from "../../shared/crypto";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";

const log = logger("service:model-provider");

export interface ModelProviderInfo {
  id: string;
  /**
   * Owner of the row: ORG_SENTINEL_USER_ID for org-tier rows, real userId
   * for personal-tier rows. Surfaced so the resolver can derive
   * `secretUserId` from the resolved row instead of hardcoding the sentinel
   * (Epic #11868 — personal model providers).
   */
  userId: string;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  secretName: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  // OAuth refresh state (mirrors `connectors`); set by the firewall refresh
  // pipeline for OAuth-typed providers like codex-oauth-token. Other
  // provider types leave these at the default values.
  tokenExpiresAt: Date | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
  // ChatGPT-only metadata captured at OAuth connect time. null on every
  // other provider type. Surfaced so the UI can render workspace + plan.
  workspaceName: string | null;
  planType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared SELECT projection for reading model_providers rows joined with secrets.
 *
 * Centralized to prevent column drift across read paths
 * (`listModelProviders`, `getModelProviderById`, `getUserModelProviderByType`).
 */
function selectProviderRow(): {
  id: typeof modelProviders.id;
  userId: typeof modelProviders.userId;
  type: typeof modelProviders.type;
  isDefault: typeof modelProviders.isDefault;
  selectedModel: typeof modelProviders.selectedModel;
  authMethod: typeof modelProviders.authMethod;
  secretName: typeof secrets.name;
  tokenExpiresAt: typeof modelProviders.tokenExpiresAt;
  needsReconnect: typeof modelProviders.needsReconnect;
  lastRefreshErrorCode: typeof modelProviders.lastRefreshErrorCode;
  workspaceName: typeof modelProviders.workspaceName;
  planType: typeof modelProviders.planType;
  createdAt: typeof modelProviders.createdAt;
  updatedAt: typeof modelProviders.updatedAt;
} {
  return {
    id: modelProviders.id,
    userId: modelProviders.userId,
    type: modelProviders.type,
    isDefault: modelProviders.isDefault,
    selectedModel: modelProviders.selectedModel,
    authMethod: modelProviders.authMethod,
    secretName: secrets.name,
    tokenExpiresAt: modelProviders.tokenExpiresAt,
    needsReconnect: modelProviders.needsReconnect,
    lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
    workspaceName: modelProviders.workspaceName,
    planType: modelProviders.planType,
    createdAt: modelProviders.createdAt,
    updatedAt: modelProviders.updatedAt,
  };
}

/**
 * Defense-in-depth check rejecting vm0 user-tier writes (Epic #11868 Decision 4).
 *
 * vm0 is a no-secret meta-provider and is org-only — the personal tier is BYOK
 * only. Called from both `upsertModelProvider` and `upsertNoSecretModelProvider`
 * since vm0 normally flows through the latter, but the former must also reject
 * user-tier vm0 attempts as defense-in-depth alongside frontend filtering.
 */
function assertVm0OrgOnly(type: ModelProviderType, userId: string): void {
  if (type === "vm0" && userId !== ORG_SENTINEL_USER_ID) {
    throw badRequest(
      "VM0 managed provider is org-only and cannot be configured per-user",
    );
  }
}

/**
 * Build a ModelProviderInfo from raw fields.
 * Derives framework from type, and secretNames from authMethod when not explicitly provided.
 */
function toModelProviderInfo(params: {
  id: string;
  userId: string;
  type: ModelProviderType;
  secretName?: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  tokenExpiresAt?: Date | null;
  needsReconnect?: boolean;
  lastRefreshErrorCode?: string | null;
  workspaceName?: string | null;
  planType?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ModelProviderInfo {
  const authMethod = params.authMethod ?? null;
  const secretNames =
    params.secretNames !== undefined
      ? params.secretNames
      : authMethod
        ? (getSecretNamesForAuthMethod(params.type, authMethod) ?? null)
        : null;

  return {
    id: params.id,
    userId: params.userId,
    type: params.type,
    framework: getFrameworkForType(params.type),
    secretName: params.secretName ?? null,
    authMethod,
    secretNames,
    isDefault: params.isDefault,
    selectedModel: params.selectedModel,
    tokenExpiresAt: params.tokenExpiresAt ?? null,
    needsReconnect: params.needsReconnect ?? false,
    lastRefreshErrorCode: params.lastRefreshErrorCode ?? null,
    workspaceName: params.workspaceName ?? null,
    planType: params.planType ?? null,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

/**
 * List all model providers for an org
 */
async function listModelProviders(
  orgId: string,
  userId: string,
): Promise<ModelProviderInfo[]> {
  // Use leftJoin to include multi-auth providers that don't have secretId
  const result = await globalThis.services.db
    .select(selectProviderRow())
    .from(modelProviders)
    .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    )
    .orderBy(modelProviders.type);

  return result.map((row) => {
    return toModelProviderInfo({
      id: row.id,
      userId: row.userId,
      type: row.type as ModelProviderType,
      secretName: row.secretName,
      authMethod: row.authMethod,
      isDefault: row.isDefault,
      selectedModel: row.selectedModel,
      tokenExpiresAt: row.tokenExpiresAt,
      needsReconnect: row.needsReconnect,
      lastRefreshErrorCode: row.lastRefreshErrorCode,
      workspaceName: row.workspaceName,
      planType: row.planType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
}

/**
 * Create or update a model provider (legacy single-secret)
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to handle concurrent requests safely.
 *
 * @param selectedModel For providers with model selection, the chosen model
 *
 * Note: Multi-auth providers (like aws-bedrock) should use upsertMultiAuthModelProvider instead
 * Note: User secrets and model-provider secrets are isolated by type, so no conflict detection needed
 */
async function upsertModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  assertVm0OrgOnly(type, userId);

  // Multi-auth providers need different handling
  if (hasAuthMethods(type)) {
    throw badRequest(
      `Provider "${type}" requires multiple secrets. Use the multi-auth API instead.`,
    );
  }

  const secretName = getSecretNameForType(type);
  if (!secretName) {
    throw badRequest(`Provider "${type}" does not have a secret name`);
  }
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptSecretValue(secret, encryptionKey);

  log.debug("upserting model provider", {
    orgId,
    type,
    secretName,
  });

  // Pre-check: does a provider for this type already exist?
  // Race window is benign — worst case, two concurrent creates both return created:true (cosmetic only)
  const [existingProvider] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // Atomic secret upsert — handles concurrent requests safely
  const [upsertedSecret] = await globalThis.services.db
    .insert(secrets)
    .values({
      userId,
      name: secretName,
      encryptedValue,
      type: "model-provider",
      description: `Model provider secret for ${MODEL_PROVIDER_TYPES[type].label}`,
      orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: { encryptedValue, updatedAt: new Date() },
    })
    .returning();

  // Atomic model provider upsert — handles concurrent requests safely
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      secretId: upsertedSecret!.id,
      isDefault: false,
      selectedModel: selectedModel ?? null,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        secretId: upsertedSecret!.id,
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  log.debug(wasCreated ? "model provider created" : "model provider updated", {
    providerId: provider!.id,
    type,
    selectedModel,
  });

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      userId,
      type,
      secretName,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      tokenExpiresAt: provider!.tokenExpiresAt,
      needsReconnect: provider!.needsReconnect,
      lastRefreshErrorCode: provider!.lastRefreshErrorCode,
      workspaceName: provider!.workspaceName,
      planType: provider!.planType,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * Upsert a single secret for a multi-auth provider.
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to handle concurrent requests safely.
 * Note: Only targets model-provider type secrets (user secrets are independent)
 */
async function upsertMultiAuthSecret(
  orgId: string,
  userId: string,
  name: string,
  value: string,
  description: string,
  encryptionKey: string,
): Promise<void> {
  const encryptedValue = encryptSecretValue(value, encryptionKey);

  await globalThis.services.db
    .insert(secrets)
    .values({
      userId,
      name,
      encryptedValue,
      type: "model-provider",
      description,
      orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: { encryptedValue, description, updatedAt: new Date() },
    });
}

/**
 * Clean up old secrets when switching auth methods
 */
async function cleanupOldAuthMethodSecrets(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  oldAuthMethod: string,
  newSecretNames: string[],
): Promise<void> {
  const oldSecretNames = getSecretNamesForAuthMethod(type, oldAuthMethod);

  // Find secrets that exist in old auth method but not in new
  const secretsToDelete = oldSecretNames?.filter((name) => {
    return !newSecretNames.includes(name);
  });

  if (secretsToDelete && secretsToDelete.length > 0) {
    await globalThis.services.db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          inArray(secrets.name, secretsToDelete),
        ),
      );
    log.debug("old auth method secrets cleaned up", {
      orgId,
      type,
      oldAuthMethod,
      deletedSecrets: secretsToDelete,
    });
  }
}

/**
 * Build the SET clause for the multi-auth upsert's onConflictDoUpdate.
 * Extracted to keep `upsertMultiAuthModelProvider` under the per-function
 * complexity ceiling — every conditional metadata spread inside the inline
 * .set() pushed it past the 20-branch limit.
 *
 * - When `metadata` is undefined (selectedModel-only update path), only
 *   `authMethod`/`selectedModel`/`updatedAt` change. Existing OAuth metadata
 *   is preserved.
 * - When `metadata` is present (re-OAuth path), the metadata fields update
 *   AND the stale flags clear atomically. Re-connect IS the recovery path.
 */
interface MultiAuthMetadata {
  tokenExpiresAt?: Date | null;
  workspaceName?: string | null;
  planType?: string | null;
}

type MultiAuthInsertValues = typeof modelProviders.$inferInsert;

/**
 * Build the .values() shape for a multi-auth INSERT. Extracted alongside
 * `buildMultiAuthConflictSet` so the parent function keeps complexity under
 * the per-function ceiling — the four `?? null` chains for OAuth metadata
 * each count as a branch.
 */
function buildMultiAuthInsertValues(args: {
  type: ModelProviderType;
  userId: string;
  authMethod: string;
  selectedModel: string | undefined;
  orgId: string;
  metadata: MultiAuthMetadata | undefined;
}): MultiAuthInsertValues {
  return {
    type: args.type,
    userId: args.userId,
    authMethod: args.authMethod,
    isDefault: false,
    selectedModel: args.selectedModel ?? null,
    orgId: args.orgId,
    tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
    workspaceName: args.metadata?.workspaceName ?? null,
    planType: args.metadata?.planType ?? null,
  };
}

function buildMultiAuthConflictSet(
  authMethod: string,
  selectedModel: string | undefined,
  metadata?: MultiAuthMetadata,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    authMethod,
    selectedModel: selectedModel ?? null,
    updatedAt: new Date(),
  };
  if (!metadata) return base;
  if (metadata.tokenExpiresAt !== undefined) {
    base.tokenExpiresAt = metadata.tokenExpiresAt;
  }
  if (metadata.workspaceName !== undefined) {
    base.workspaceName = metadata.workspaceName;
  }
  if (metadata.planType !== undefined) {
    base.planType = metadata.planType;
  }
  base.needsReconnect = false;
  base.lastRefreshErrorCode = null;
  return base;
}

/**
 * Create or update a multi-auth model provider (like aws-bedrock)
 * @param authMethod The auth method to use (e.g., "api-key", "access-keys")
 * @param secretValues Map of secret names to their values
 * @param selectedModel Optional selected model
 * @param metadata Optional OAuth/connect-time metadata. When passed, the row's
 *   `tokenExpiresAt`/`workspaceName`/`planType` are written, AND the stale
 *   flags (`needsReconnect` + `lastRefreshErrorCode`) are cleared atomically
 *   in the same transaction. Re-OAuth IS the recovery path; without this the
 *   user would stay stuck-stale even after a successful re-connect.
 */
async function upsertMultiAuthModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
  metadata?: {
    tokenExpiresAt?: Date | null;
    workspaceName?: string | null;
    planType?: string | null;
  },
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  // Verify this is a multi-auth provider
  if (!hasAuthMethods(type)) {
    throw badRequest(
      `Provider "${type}" is a legacy single-secret provider. Use the standard upsert API.`,
    );
  }

  // Validate auth method
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethod in authMethods)) {
    const validMethods = authMethods ? Object.keys(authMethods).join(", ") : "";
    throw badRequest(
      `Invalid auth method "${authMethod}" for provider "${type}". Valid methods: ${validMethods}`,
    );
  }

  // Validate required secrets
  const secretsConfig = getSecretsForAuthMethod(type, authMethod);
  if (!secretsConfig) {
    throw badRequest(`No secrets config found for auth method "${authMethod}"`);
  }

  const missingRequired: string[] = [];
  for (const [name, config] of Object.entries(secretsConfig)) {
    if (config.required && !secretValues[name]) {
      missingRequired.push(name);
    }
  }

  if (missingRequired.length > 0) {
    throw badRequest(
      `Missing required secrets for ${authMethod}: ${missingRequired.join(", ")}`,
    );
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

  log.debug("upserting multi-auth model provider", {
    orgId,
    type,
    authMethod,
    secretNames: Object.keys(secretValues),
  });

  // Check if model provider already exists (needed for auth method switch cleanup)
  const [existingProvider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // If switching auth methods, clean up old secrets that are no longer used
  if (existingProvider && existingProvider.authMethod !== authMethod) {
    await cleanupOldAuthMethodSecrets(
      orgId,
      userId,
      type,
      existingProvider.authMethod ?? "",
      Object.keys(secretValues),
    );
  }

  // Store/update all secrets atomically
  const secretNames = Object.keys(secretValues);
  const secretDescription = `${MODEL_PROVIDER_TYPES[type].label} secret (${authMethod})`;

  for (const [name, value] of Object.entries(secretValues)) {
    await upsertMultiAuthSecret(
      orgId,
      userId,
      name,
      value,
      secretDescription,
      encryptionKey,
    );
  }

  // Atomic model provider upsert — handles concurrent requests safely.
  // When `metadata` is present, also write OAuth metadata and clear stale
  // flags (re-connect == recovery) in the same transaction.
  const insertValues = buildMultiAuthInsertValues({
    type,
    userId,
    authMethod,
    selectedModel,
    orgId,
    metadata,
  });
  const conflictSet = buildMultiAuthConflictSet(
    authMethod,
    selectedModel,
    metadata,
  );
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: conflictSet,
    })
    .returning();

  const wasCreated = !existingProvider;

  log.debug(
    wasCreated
      ? "multi-auth model provider created"
      : "multi-auth model provider updated",
    {
      providerId: provider!.id,
      type,
      authMethod,
      selectedModel,
    },
  );

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      userId,
      type,
      authMethod,
      secretNames,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      tokenExpiresAt: provider!.tokenExpiresAt,
      needsReconnect: provider!.needsReconnect,
      lastRefreshErrorCode: provider!.lastRefreshErrorCode,
      workspaceName: provider!.workspaceName,
      planType: provider!.planType,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * Create or update a model provider that requires no secret (e.g., vm0 managed provider).
 * Inserts model_providers with secretId = NULL and authMethod = NULL.
 */
async function upsertNoSecretModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  assertVm0OrgOnly(type, userId);

  log.debug("upserting no-secret model provider", {
    orgId,
    type,
    selectedModel,
  });

  // Pre-check: does a provider for this type already exist?
  const [existingProvider] = await globalThis.services.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  // Atomic model provider upsert
  const [provider] = await globalThis.services.db
    .insert(modelProviders)
    .values({
      type,
      userId,
      isDefault: false,
      selectedModel: selectedModel ?? null,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        modelProviders.orgId,
        modelProviders.userId,
        modelProviders.type,
      ],
      set: {
        selectedModel: selectedModel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  const wasCreated = !existingProvider;

  log.debug(
    wasCreated
      ? "no-secret model provider created"
      : "no-secret model provider updated",
    {
      providerId: provider!.id,
      type,
      selectedModel,
    },
  );

  return {
    provider: toModelProviderInfo({
      id: provider!.id,
      userId,
      type,
      isDefault: provider!.isDefault,
      selectedModel: provider!.selectedModel,
      tokenExpiresAt: provider!.tokenExpiresAt,
      needsReconnect: provider!.needsReconnect,
      lastRefreshErrorCode: provider!.lastRefreshErrorCode,
      workspaceName: provider!.workspaceName,
      planType: provider!.planType,
      createdAt: provider!.createdAt,
      updatedAt: provider!.updatedAt,
    }),
    created: wasCreated,
  };
}

/**
 * Delete a model provider and its secret
 */
async function deleteModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
): Promise<void> {
  // Find the model provider
  const [provider] = await globalThis.services.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  if (!provider) {
    throw notFound(`Model provider "${type}" not found`);
  }

  const secretId = provider.secretId;

  // Single-secret providers cascade through their model_provider row.
  if (secretId) {
    await globalThis.services.db
      .delete(secrets)
      .where(eq(secrets.id, secretId));
  } else {
    // Multi-auth providers: delete all associated secrets
    if (provider.authMethod) {
      const secretNames = getSecretNamesForAuthMethod(
        type,
        provider.authMethod,
      );
      if (secretNames && secretNames.length > 0) {
        await globalThis.services.db
          .delete(secrets)
          .where(
            and(
              eq(secrets.orgId, orgId),
              eq(secrets.userId, userId),
              inArray(secrets.name, secretNames),
            ),
          );
        log.debug("multi-auth secrets deleted", {
          orgId,
          type,
          secretNames,
        });
      }
    }
    // Delete the model_provider
    await globalThis.services.db
      .delete(modelProviders)
      .where(eq(modelProviders.id, provider.id));
  }

  log.debug("model provider deleted", { orgId, type });
}

// ============================================================================
// Org-Level Model Provider Functions
//
// These delegate to the user-level functions using ORG_SENTINEL_USER_ID.
// The sentinel userId ensures org and user providers are fully isolated.
// ============================================================================

/**
 * List all org-level model providers
 */
export function listOrgModelProviders(
  orgId: string,
): Promise<ModelProviderInfo[]> {
  return listModelProviders(orgId, ORG_SENTINEL_USER_ID);
}

/**
 * Create or update an org-level model provider (single-secret).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 */
export function upsertOrgModelProvider(
  orgId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    secret,
    selectedModel,
  );
}

/**
 * Create or update an org-level multi-auth model provider (e.g., aws-bedrock).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 *
 * `metadata` carries OAuth/connect-time fields (tokenExpiresAt, workspaceName,
 * planType). Passing it both writes those columns AND clears stale flags —
 * see `upsertMultiAuthModelProvider` doc for details.
 */
export function upsertOrgMultiAuthModelProvider(
  orgId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
  metadata?: {
    tokenExpiresAt?: Date | null;
    workspaceName?: string | null;
    planType?: string | null;
  },
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertMultiAuthModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    authMethod,
    secretValues,
    selectedModel,
    metadata,
  );
}

/**
 * Create or update an org-level no-secret model provider (e.g., vm0).
 * Uses ORG_SENTINEL_USER_ID for org-scoped storage.
 */
export function upsertOrgNoSecretModelProvider(
  orgId: string,
  type: ModelProviderType,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertNoSecretModelProvider(
    orgId,
    ORG_SENTINEL_USER_ID,
    type,
    selectedModel,
  );
}

/**
 * Delete an org-level model provider and its secrets
 */
export function deleteOrgModelProvider(
  orgId: string,
  type: ModelProviderType,
): Promise<void> {
  return deleteModelProvider(orgId, ORG_SENTINEL_USER_ID, type);
}

/**
 * Get a specific model provider by ID, user-aware.
 *
 * Org-tier rows (`userId = '__org__'`) are visible to any caller in the org.
 * User-tier rows are visible only to their owner — an org admin querying a
 * teammate's personal-provider id receives `null`, preserving the privacy
 * invariant from Epic #11868 Decision 1. Returns null if no row matches or
 * if the row's type is not in the registry.
 */
export async function getModelProviderById(
  orgId: string,
  userId: string,
  providerId: string,
): Promise<ModelProviderInfo | null> {
  const [row] = await globalThis.services.db
    .select(selectProviderRow())
    .from(modelProviders)
    .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.id, providerId),
        or(
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          eq(modelProviders.userId, userId),
        ),
      ),
    )
    .limit(1);

  if (!row) return null;

  if (!(row.type in MODEL_PROVIDER_TYPES)) return null;

  return toModelProviderInfo({
    id: row.id,
    userId: row.userId,
    type: row.type as ModelProviderType,
    secretName: row.secretName,
    authMethod: row.authMethod,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    tokenExpiresAt: row.tokenExpiresAt,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    workspaceName: row.workspaceName,
    planType: row.planType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ============================================================================
// User-Level (BYOK) Model Provider Functions
//
// Personal tier per Epic #11868: each user owns their own model providers
// within an org. These mirror the Org-tier wrappers but parameterize on a
// real userId. VM0 is org-only — rejected at the generic core in
// upsertModelProvider / upsertNoSecretModelProvider.
// ============================================================================

/**
 * List all user-level model providers for a given user in an org
 */
export function listUserModelProviders(
  orgId: string,
  userId: string,
): Promise<ModelProviderInfo[]> {
  return listModelProviders(orgId, userId);
}

/**
 * Create or update a user-level (BYOK) model provider (single-secret).
 */
export function upsertUserModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  secret: string,
  selectedModel?: string,
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertModelProvider(orgId, userId, type, secret, selectedModel);
}

/**
 * Create or update a user-level multi-auth model provider (e.g., aws-bedrock).
 *
 * `metadata` carries OAuth/connect-time fields (tokenExpiresAt, workspaceName,
 * planType) for OAuth-typed providers. See `upsertMultiAuthModelProvider` for
 * the recovery semantics (passing metadata clears stale flags atomically).
 */
export function upsertUserMultiAuthModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
  metadata?: {
    tokenExpiresAt?: Date | null;
    workspaceName?: string | null;
    planType?: string | null;
  },
): Promise<{ provider: ModelProviderInfo; created: boolean }> {
  return upsertMultiAuthModelProvider(
    orgId,
    userId,
    type,
    authMethod,
    secretValues,
    selectedModel,
    metadata,
  );
}

// Note: NO upsertUserNoSecretModelProvider — vm0 is org-only per Epic #11868
// Decision 4. The throw lives in upsertNoSecretModelProvider directly.

/**
 * Delete a user-level model provider and its secrets
 */
export function deleteUserModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
): Promise<void> {
  return deleteModelProvider(orgId, userId, type);
}

/**
 * Get the user-level model provider row for a specific type.
 *
 * Returns null when the user has no row of that type.
 */
export async function getUserModelProviderByType(
  orgId: string,
  userId: string,
  type: ModelProviderType,
): Promise<ModelProviderInfo | null> {
  const [row] = await globalThis.services.db
    .select(selectProviderRow())
    .from(modelProviders)
    .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        eq(modelProviders.type, type),
      ),
    )
    .limit(1);

  if (!row) return null;
  if (!(row.type in MODEL_PROVIDER_TYPES)) return null;

  return toModelProviderInfo({
    id: row.id,
    userId: row.userId,
    type: row.type as ModelProviderType,
    secretName: row.secretName,
    authMethod: row.authMethod,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    tokenExpiresAt: row.tokenExpiresAt,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    workspaceName: row.workspaceName,
    planType: row.planType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
