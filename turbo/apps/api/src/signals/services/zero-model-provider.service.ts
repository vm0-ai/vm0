import { command, computed, type Computed } from "ccstate";
import {
  getAuthMethodsForType,
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  getSecretsForAuthMethod,
  hasAuthMethods,
  isModelProviderFrameworkFeatureSwitched,
  MODEL_PROVIDER_TYPES,
  type ModelProviderFramework,
  type ModelProviderFeatureStates,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type ModelProviderType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db$, writeDb$, type Db } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { encryptStoredSecretValue } from "./crypto.utils";
import { lockModelProviderState } from "./auth-state-lock.service";
import { userFeatureSwitchContext } from "./feature-switches.service";

const L = logger("zero-model-provider.service");

const ORG_SENTINEL_USER_ID = "__org__";
type ModelProviderRow = typeof modelProviders.$inferSelect;

function hasUsableSecretValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function modelProviderResponse(
  row: {
    readonly id: string;
    readonly type: string;
    readonly isDefault: boolean;
    readonly selectedModel: string | null;
    readonly authMethod: string | null;
    readonly secretName: string | null;
    readonly workspaceName: string | null;
    readonly planType: string | null;
    readonly subscriptionResetPeriod: string | null;
    readonly subscriptionNextResetAt: Date | null;
    readonly needsReconnect: boolean;
    readonly lastRefreshErrorCode: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  featureStates?: ModelProviderFeatureStates,
): ModelProviderResponse | null {
  const parsed = modelProviderTypeSchema.safeParse(row.type);
  if (!parsed.success) {
    return null;
  }

  const authMethod = row.authMethod ?? null;
  return {
    id: row.id,
    type: parsed.data,
    framework: getFrameworkForType(parsed.data, featureStates),
    secretName: row.secretName,
    authMethod,
    secretNames: authMethod
      ? (getSecretNamesForAuthMethod(parsed.data, authMethod) ?? null)
      : null,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    workspaceName: row.workspaceName,
    planType: row.planType,
    subscriptionResetPeriod: row.subscriptionResetPeriod,
    subscriptionNextResetAt: row.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function zeroModelProvidersForUser(
  orgId: string,
  ownerUserId: string,
  viewerUserId: string = ownerUserId,
): Computed<Promise<ModelProviderListResponse>> {
  return computed(async (get): Promise<ModelProviderListResponse> => {
    const rows = await get(db$)
      .select({
        id: modelProviders.id,
        type: modelProviders.type,
        isDefault: modelProviders.isDefault,
        selectedModel: modelProviders.selectedModel,
        authMethod: modelProviders.authMethod,
        secretName: secrets.name,
        workspaceName: modelProviders.workspaceName,
        planType: modelProviders.planType,
        subscriptionResetPeriod: modelProviders.subscriptionResetPeriod,
        subscriptionNextResetAt: modelProviders.subscriptionNextResetAt,
        needsReconnect: modelProviders.needsReconnect,
        lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
        createdAt: modelProviders.createdAt,
        updatedAt: modelProviders.updatedAt,
      })
      .from(modelProviders)
      .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ownerUserId),
        ),
      )
      .orderBy(modelProviders.type);

    const providers = rows.flatMap((row) => {
      const provider = modelProviderResponse(row);
      return provider ? [provider] : [];
    });
    if (
      !providers.some((provider) => {
        return isModelProviderFrameworkFeatureSwitched(provider.type);
      })
    ) {
      return { modelProviders: providers };
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(orgId, viewerUserId),
    );
    const featureStates = getAllFeatureStates(featureSwitchContext);

    return {
      modelProviders: providers.flatMap((provider) => {
        return [
          {
            ...provider,
            framework: getFrameworkForType(provider.type, featureStates),
          },
        ];
      }),
    };
  });
}

export function zeroModelProviders(
  orgId: string,
  viewerUserId: string,
): Computed<Promise<ModelProviderListResponse>> {
  return zeroModelProvidersForUser(orgId, ORG_SENTINEL_USER_ID, viewerUserId);
}

export function zeroUserModelProviders(
  orgId: string,
  userId: string,
): Computed<Promise<ModelProviderListResponse>> {
  return zeroModelProvidersForUser(orgId, userId);
}

type NotFoundResponse = ReturnType<typeof notFound>;

/**
 * Delete a user-level model provider and cascade-delete its secrets.
 *
 * Delete behavior:
 *   - Legacy single-secret providers: deleting the secret cascades the
 *     model_provider row via FK (`onDelete: "cascade"` at the schema).
 *   - Multi-auth providers: deletes the per-auth-method secrets by name,
 *     then deletes the model_provider row explicitly.
 *
 * Uses the same auth-state advisory lock as runtime access refresh so a refresh
 * cannot recreate secrets after a delete.
 */
export const deleteUserModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderType;
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const writeDb = set(writeDb$);

    return await writeDb.transaction(async (tx) => {
      await lockModelProviderState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
      });
      signal.throwIfAborted();

      const [provider] = await tx
        .select({
          id: modelProviders.id,
          isDefault: modelProviders.isDefault,
          secretId: modelProviders.secretId,
          authMethod: modelProviders.authMethod,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.type, args.type),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!provider) {
        return notFound("Resource not found");
      }

      if (provider.secretId) {
        await tx.delete(secrets).where(eq(secrets.id, provider.secretId));
        signal.throwIfAborted();
      } else {
        if (provider.authMethod) {
          const secretNames = getSecretNamesForAuthMethod(
            args.type,
            provider.authMethod,
          );
          if (secretNames && secretNames.length > 0) {
            await tx
              .delete(secrets)
              .where(
                and(
                  eq(secrets.orgId, args.orgId),
                  eq(secrets.userId, args.userId),
                  inArray(secrets.name, [...secretNames]),
                ),
              );
            signal.throwIfAborted();
          }
        }
        await tx
          .delete(modelProviders)
          .where(eq(modelProviders.id, provider.id));
        signal.throwIfAborted();
      }

      return undefined;
    });
  },
);

export const deleteOrgModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderType;
    },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    return await set(
      deleteUserModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
      },
      signal,
    );
  },
);

// ===========================================================================
// Upsert path for API model-provider routes.
//
// Shared upsert path for API org and personal model-provider routes. Returns
// either a `BadRequestResponse` or `{ provider, created }`.
// ===========================================================================

type BadRequestResponse = ReturnType<typeof badRequestMessage>;

/**
 * Row shape returned to the route handler. The codex paste handler's
 * `UpsertedProvider` remains a structural subset of this shape.
 */
export interface ModelProviderInfo {
  readonly id: string;
  readonly userId: string;
  readonly type: ModelProviderType;
  readonly framework: ModelProviderFramework;
  readonly secretName: string | null;
  readonly authMethod: string | null;
  readonly secretNames: string[] | null;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly workspaceName: string | null;
  readonly planType: string | null;
  readonly subscriptionResetPeriod: string | null;
  readonly subscriptionNextResetAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toModelProviderInfo(
  params: {
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
    subscriptionResetPeriod?: string | null;
    subscriptionNextResetAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  featureStates?: ModelProviderFeatureStates,
): ModelProviderInfo {
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
    framework: getFrameworkForType(params.type, featureStates),
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
    subscriptionResetPeriod: params.subscriptionResetPeriod ?? null,
    subscriptionNextResetAt: params.subscriptionNextResetAt ?? null,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

function toModelProviderInfoFromRow(args: {
  readonly provider: ModelProviderRow;
  readonly userId: string;
  readonly type: ModelProviderType;
  readonly secretName?: string | null;
  readonly authMethod?: string | null;
  readonly secretNames?: string[] | null;
  readonly featureStates?: ModelProviderFeatureStates;
}): ModelProviderInfo {
  const { provider } = args;
  return toModelProviderInfo(
    {
      id: provider.id,
      userId: args.userId,
      type: args.type,
      secretName: args.secretName,
      authMethod: args.authMethod,
      secretNames: args.secretNames,
      isDefault: provider.isDefault,
      selectedModel: provider.selectedModel,
      tokenExpiresAt: provider.tokenExpiresAt,
      needsReconnect: provider.needsReconnect,
      lastRefreshErrorCode: provider.lastRefreshErrorCode,
      workspaceName: provider.workspaceName,
      planType: provider.planType,
      subscriptionResetPeriod: provider.subscriptionResetPeriod,
      subscriptionNextResetAt: provider.subscriptionNextResetAt,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    },
    args.featureStates,
  );
}

/**
 * Reject vm0 on personal-tier callers — vm0 is org-only per Epic #11868.
 * Returns BadRequestResponse so the route handler emits 400 without throwing.
 */
function assertVm0OrgOnly(
  type: ModelProviderType,
  userId: string,
): BadRequestResponse | null {
  if (type === "vm0" && userId !== ORG_SENTINEL_USER_ID) {
    return badRequestMessage(
      "VM0 managed provider is org-only and cannot be configured per-user",
    );
  }
  return null;
}

function validateSingleSecretProviderRequest(args: {
  readonly type: ModelProviderType;
  readonly secret: string;
}): BadRequestResponse | { readonly secretName: string } {
  const secretName = getSecretNameForType(args.type);
  if (!secretName) {
    return badRequestMessage(
      `Provider "${args.type}" does not have a secret name`,
    );
  }
  if (!hasUsableSecretValue(args.secret)) {
    return badRequestMessage(
      `Provider "${args.type}" requires a non-empty secret`,
    );
  }
  return { secretName };
}

async function validateSingleSecretProviderUpsert(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchUserId?: string;
    readonly type: ModelProviderType;
    readonly secret: string;
  },
  loadFeatureSwitchContext: (userId: string) => Promise<FeatureSwitchContext>,
  signal: AbortSignal,
): Promise<
  | BadRequestResponse
  | {
      readonly secretName: string;
      readonly featureSwitchContext: FeatureSwitchContext | undefined;
      readonly featureStates: ModelProviderFeatureStates | undefined;
    }
> {
  let featureSwitchContext: FeatureSwitchContext | undefined;
  let featureStates: ModelProviderFeatureStates | undefined;
  if (isModelProviderFrameworkFeatureSwitched(args.type)) {
    featureSwitchContext = await loadFeatureSwitchContext(
      args.featureSwitchUserId ?? args.userId,
    );
    signal.throwIfAborted();
    featureStates = getAllFeatureStates(featureSwitchContext);
  }

  const validation = validateSingleSecretProviderRequest(args);
  if ("status" in validation) {
    return validation;
  }
  return { ...validation, featureSwitchContext, featureStates };
}

interface ModelProviderMetadata {
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

interface EncryptedMultiAuthSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

type MultiAuthInsertValues = typeof modelProviders.$inferInsert;

function buildMultiAuthInsertValues(args: {
  type: ModelProviderType;
  userId: string;
  authMethod: string;
  selectedModel: string | undefined;
  orgId: string;
  metadata: ModelProviderMetadata | undefined;
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
    subscriptionResetPeriod: args.metadata?.subscriptionResetPeriod ?? null,
    subscriptionNextResetAt: args.metadata?.subscriptionNextResetAt ?? null,
  };
}

function buildMultiAuthConflictSet(
  authMethod: string,
  selectedModel: string | undefined,
  metadata?: ModelProviderMetadata,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    authMethod,
    selectedModel: selectedModel ?? null,
    updatedAt: sql`clock_timestamp()`,
  };
  if (!metadata) {
    return base;
  }
  if (metadata.tokenExpiresAt !== undefined) {
    base.tokenExpiresAt = metadata.tokenExpiresAt;
  }
  if (metadata.workspaceName !== undefined) {
    base.workspaceName = metadata.workspaceName;
  }
  if (metadata.planType !== undefined) {
    base.planType = metadata.planType;
  }
  if (metadata.subscriptionResetPeriod !== undefined) {
    base.subscriptionResetPeriod = metadata.subscriptionResetPeriod;
  }
  if (metadata.subscriptionNextResetAt !== undefined) {
    base.subscriptionNextResetAt = metadata.subscriptionNextResetAt;
  }
  base.needsReconnect = false;
  base.lastRefreshErrorCode = null;
  return base;
}

function buildSingleAuthConflictSet(args: {
  readonly secretId: string;
  readonly selectedModel: string | undefined;
  readonly metadata?: ModelProviderMetadata;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    secretId: args.secretId,
    selectedModel: args.selectedModel ?? null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    updatedAt: nowDate(),
  };
  if (!args.metadata) {
    return base;
  }
  if (args.metadata.tokenExpiresAt !== undefined) {
    base.tokenExpiresAt = args.metadata.tokenExpiresAt;
  }
  if (args.metadata.workspaceName !== undefined) {
    base.workspaceName = args.metadata.workspaceName;
  }
  if (args.metadata.planType !== undefined) {
    base.planType = args.metadata.planType;
  }
  if (args.metadata.subscriptionResetPeriod !== undefined) {
    base.subscriptionResetPeriod = args.metadata.subscriptionResetPeriod;
  }
  if (args.metadata.subscriptionNextResetAt !== undefined) {
    base.subscriptionNextResetAt = args.metadata.subscriptionNextResetAt;
  }
  return base;
}

async function cleanupOldAuthMethodSecrets(
  writeDb: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly oldAuthMethod: string;
    readonly newSecretNames: readonly string[];
  },
): Promise<void> {
  const oldSecretNames = getSecretNamesForAuthMethod(
    args.type,
    args.oldAuthMethod,
  );
  const secretsToDelete = oldSecretNames?.filter((name) => {
    return !args.newSecretNames.includes(name);
  });
  if (secretsToDelete && secretsToDelete.length > 0) {
    await writeDb
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          inArray(secrets.name, secretsToDelete),
        ),
      );
  }
}

async function upsertMultiAuthSecret(
  writeDb: Db,
  args: EncryptedMultiAuthSecret & {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await writeDb
    .insert(secrets)
    .values({
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      type: "model-provider",
      description: args.description,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue: args.encryptedValue,
        description: args.description,
        updatedAt: nowDate(),
      },
    });
}

/**
 * Create or update a single-secret personal model provider.
 */
export const upsertUserModelProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchUserId?: string;
      readonly type: ModelProviderType;
      readonly secret: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const vm0 = assertVm0OrgOnly(args.type, args.userId);
    if (vm0) {
      return vm0;
    }

    if (hasAuthMethods(args.type)) {
      return badRequestMessage(
        `Provider "${args.type}" requires multiple secrets. Use the multi-auth API instead.`,
      );
    }

    const validation = await validateSingleSecretProviderUpsert(
      args,
      async (userId) => {
        return await get(userFeatureSwitchContext(args.orgId, userId));
      },
      signal,
    );
    if ("status" in validation) {
      return validation;
    }
    const { secretName, featureSwitchContext, featureStates } = validation;
    const writeDb = set(writeDb$);

    const encryptedValue = await encryptStoredSecretValue(
      args.secret,
      featureSwitchContext,
    );
    signal.throwIfAborted();

    L.debug("upserting model provider", {
      orgId: args.orgId,
      type: args.type,
      secretName,
    });

    // Pre-check: does a provider for this type already exist?
    const [existingProvider] = await writeDb
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.type, args.type),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    // Atomic secret upsert.
    const [upsertedSecret] = await writeDb
      .insert(secrets)
      .values({
        userId: args.userId,
        name: secretName,
        encryptedValue,
        type: "model-provider",
        description: `Model provider secret for ${MODEL_PROVIDER_TYPES[args.type].label}`,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
        set: { encryptedValue, updatedAt: nowDate() },
      })
      .returning();
    signal.throwIfAborted();

    if (!upsertedSecret) {
      throw new Error("Expected secret upsert to return a row");
    }

    // Atomic model provider upsert.
    const [provider] = await writeDb
      .insert(modelProviders)
      .values({
        type: args.type,
        userId: args.userId,
        secretId: upsertedSecret.id,
        isDefault: false,
        selectedModel: args.selectedModel ?? null,
        orgId: args.orgId,
        tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
        workspaceName: args.metadata?.workspaceName ?? null,
        planType: args.metadata?.planType ?? null,
        subscriptionResetPeriod: args.metadata?.subscriptionResetPeriod ?? null,
        subscriptionNextResetAt: args.metadata?.subscriptionNextResetAt ?? null,
      })
      .onConflictDoUpdate({
        target: [
          modelProviders.orgId,
          modelProviders.userId,
          modelProviders.type,
        ],
        set: buildSingleAuthConflictSet({
          secretId: upsertedSecret.id,
          selectedModel: args.selectedModel,
          metadata: args.metadata,
        }),
      })
      .returning();
    signal.throwIfAborted();

    if (!provider) {
      throw new Error("Expected model provider upsert to return a row");
    }

    const wasCreated = !existingProvider;

    return {
      provider: toModelProviderInfoFromRow({
        provider,
        userId: args.userId,
        type: args.type,
        secretName,
        featureStates,
      }),
      created: wasCreated,
    };
  },
);

async function encryptMultiAuthSecrets(
  args: {
    readonly type: ModelProviderType;
    readonly authMethod: string;
    readonly secretValues: Record<string, string>;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<readonly EncryptedMultiAuthSecret[]> {
  const description = `${MODEL_PROVIDER_TYPES[args.type].label} secret (${args.authMethod})`;
  const encryptedSecrets: EncryptedMultiAuthSecret[] = [];
  for (const [name, value] of Object.entries(args.secretValues)) {
    const encryptedValue = await encryptStoredSecretValue(
      value,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    encryptedSecrets.push({ name, encryptedValue, description });
  }
  return encryptedSecrets;
}

/**
 * Loop over encrypted secrets and persist each via `upsertMultiAuthSecret`.
 * Extracted so the Command body stays under the per-function lint ceiling.
 */
async function persistMultiAuthSecrets(
  writeDb: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly encryptedSecrets: readonly EncryptedMultiAuthSecret[];
  },
  signal: AbortSignal,
): Promise<void> {
  for (const secret of args.encryptedSecrets) {
    await upsertMultiAuthSecret(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      ...secret,
    });
    signal.throwIfAborted();
  }
}

async function persistMultiAuthModelProvider(
  writeDb: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly authMethod: string;
    readonly selectedModel?: string;
    readonly metadata?: ModelProviderMetadata;
    readonly secretNames: readonly string[];
    readonly encryptedSecrets: readonly EncryptedMultiAuthSecret[];
  },
  signal: AbortSignal,
): Promise<{
  readonly provider: ModelProviderRow;
  readonly wasCreated: boolean;
}> {
  const result = await writeDb.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
    });
    signal.throwIfAborted();

    // Check if model provider already exists (needed for auth method switch cleanup).
    const [existingProvider] = await tx
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.type, args.type),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    // If switching auth methods, clean up old secrets that are no longer used.
    if (existingProvider && existingProvider.authMethod !== args.authMethod) {
      await cleanupOldAuthMethodSecrets(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        oldAuthMethod: existingProvider.authMethod ?? "",
        newSecretNames: args.secretNames,
      });
      signal.throwIfAborted();
    }

    // Store/update all secrets atomically with the provider row.
    await persistMultiAuthSecrets(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        encryptedSecrets: args.encryptedSecrets,
      },
      signal,
    );

    // Atomic model provider upsert; metadata-aware conflict set clears stale flags.
    const conflictSet = buildMultiAuthConflictSet(
      args.authMethod,
      args.selectedModel,
      args.metadata,
    );
    const insertValues = buildMultiAuthInsertValues({
      type: args.type,
      userId: args.userId,
      authMethod: args.authMethod,
      selectedModel: args.selectedModel,
      orgId: args.orgId,
      metadata: args.metadata,
    });
    const [provider] = await tx
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
    signal.throwIfAborted();

    if (!provider) {
      throw new Error(
        "Expected multi-auth model provider upsert to return a row",
      );
    }

    return { provider, wasCreated: !existingProvider };
  });
  signal.throwIfAborted();
  return result;
}

/**
 * Validate the multi-auth upsert input shape (auth method exists, required
 * secrets present, etc.). Returns a BadRequestResponse if any check fails;
 * otherwise null. Extracted from `upsertUserMultiAuthModelProvider$` so the
 * Command body stays under the per-function lint ceiling.
 */
function validateMultiAuthUpsertInput(args: {
  readonly type: ModelProviderType;
  readonly authMethod: string;
  readonly secretValues: Record<string, string>;
}): BadRequestResponse | null {
  if (!hasAuthMethods(args.type)) {
    return badRequestMessage(
      `Provider "${args.type}" is a legacy single-secret provider. Use the standard upsert API.`,
    );
  }

  const authMethods = getAuthMethodsForType(args.type);
  if (!authMethods || !(args.authMethod in authMethods)) {
    const validMethods = authMethods ? Object.keys(authMethods).join(", ") : "";
    return badRequestMessage(
      `Invalid auth method "${args.authMethod}" for provider "${args.type}". Valid methods: ${validMethods}`,
    );
  }

  const secretsConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretsConfig) {
    return badRequestMessage(
      `No secrets config found for auth method "${args.authMethod}"`,
    );
  }

  const missingRequired: string[] = [];
  for (const [name, config] of Object.entries(secretsConfig)) {
    if (config.required && !hasUsableSecretValue(args.secretValues[name])) {
      missingRequired.push(name);
    }
  }
  if (missingRequired.length > 0) {
    return badRequestMessage(
      `Missing required secrets for ${args.authMethod}: ${missingRequired.join(", ")}`,
    );
  }

  return null;
}

/**
 * Create or update a multi-auth personal model provider (e.g., aws-bedrock,
 * codex-oauth-token).
 */
export const upsertUserMultiAuthModelProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderType;
      readonly authMethod: string;
      readonly secretValues: Record<string, string>;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const validationError = validateMultiAuthUpsertInput({
      type: args.type,
      authMethod: args.authMethod,
      secretValues: args.secretValues,
    });
    if (validationError) {
      return validationError;
    }

    const writeDb = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const secretNames = Object.keys(args.secretValues);
    const encryptedSecrets = await encryptMultiAuthSecrets(
      { ...args, featureSwitchContext },
      signal,
    );

    L.debug("upserting multi-auth model provider", {
      orgId: args.orgId,
      type: args.type,
      authMethod: args.authMethod,
      secretNames,
    });

    const result = await persistMultiAuthModelProvider(
      writeDb,
      {
        ...args,
        secretNames,
        encryptedSecrets,
      },
      signal,
    );
    signal.throwIfAborted();

    const { provider } = result;

    return {
      provider: toModelProviderInfoFromRow({
        provider,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        secretNames,
      }),
      created: result.wasCreated,
    };
  },
);

export const upsertOrgModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly viewerUserId?: string;
      readonly type: ModelProviderType;
      readonly secret: string;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      upsertUserModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        featureSwitchUserId: args.viewerUserId ?? ORG_SENTINEL_USER_ID,
        type: args.type,
        secret: args.secret,
        selectedModel: args.selectedModel,
        metadata: args.metadata,
      },
      signal,
    );
  },
);

export const upsertOrgMultiAuthModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderType;
      readonly authMethod: string;
      readonly secretValues: Record<string, string>;
      readonly selectedModel?: string;
      readonly metadata?: ModelProviderMetadata;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      upsertUserMultiAuthModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
        authMethod: args.authMethod,
        secretValues: args.secretValues,
        selectedModel: args.selectedModel,
        metadata: args.metadata,
      },
      signal,
    );
  },
);

export const upsertOrgNoSecretModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderType;
      readonly selectedModel?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | { readonly provider: ModelProviderInfo; readonly created: boolean }
  > => {
    const vm0 = assertVm0OrgOnly(args.type, ORG_SENTINEL_USER_ID);
    if (vm0) {
      return vm0;
    }

    const writeDb = set(writeDb$);

    L.debug("upserting org no-secret model provider", {
      orgId: args.orgId,
      type: args.type,
      selectedModel: args.selectedModel,
    });

    const [existingProvider] = await writeDb
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          eq(modelProviders.type, args.type),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const [provider] = await writeDb
      .insert(modelProviders)
      .values({
        type: args.type,
        userId: ORG_SENTINEL_USER_ID,
        isDefault: false,
        selectedModel: args.selectedModel ?? null,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [
          modelProviders.orgId,
          modelProviders.userId,
          modelProviders.type,
        ],
        set: {
          selectedModel: args.selectedModel ?? null,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!provider) {
      throw new Error("Expected no-secret model provider upsert to return row");
    }

    return {
      provider: toModelProviderInfoFromRow({
        provider,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
      }),
      created: !existingProvider,
    };
  },
);
