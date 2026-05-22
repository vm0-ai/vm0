import { command, computed, type Computed } from "ccstate";
import {
  getAuthMethodsForType,
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  getSecretsForAuthMethod,
  hasAuthMethods,
  MODEL_PROVIDER_TYPES,
  type ModelProviderFramework,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type ModelProviderType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";

import { db$, writeDb$, type Db } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { encryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

const L = logger("zero-model-provider.service");

const ORG_SENTINEL_USER_ID = "__org__";

function modelProviderResponse(row: {
  readonly id: string;
  readonly type: string;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly authMethod: string | null;
  readonly secretName: string | null;
  readonly workspaceName: string | null;
  readonly planType: string | null;
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ModelProviderResponse | null {
  const parsed = modelProviderTypeSchema.safeParse(row.type);
  if (!parsed.success) {
    return null;
  }

  const authMethod = row.authMethod ?? null;
  return {
    id: row.id,
    type: parsed.data,
    framework: getFrameworkForType(parsed.data),
    secretName: row.secretName,
    authMethod,
    secretNames: authMethod
      ? (getSecretNamesForAuthMethod(parsed.data, authMethod) ?? null)
      : null,
    isDefault: row.isDefault,
    selectedModel: row.selectedModel,
    workspaceName: row.workspaceName,
    planType: row.planType,
    needsReconnect: row.needsReconnect,
    lastRefreshErrorCode: row.lastRefreshErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function zeroModelProvidersForUser(
  orgId: string,
  userId: string,
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
        needsReconnect: modelProviders.needsReconnect,
        lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
        createdAt: modelProviders.createdAt,
        updatedAt: modelProviders.updatedAt,
      })
      .from(modelProviders)
      .leftJoin(secrets, eq(modelProviders.secretId, secrets.id))
      .where(
        and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
      )
      .orderBy(modelProviders.type);

    return {
      modelProviders: rows.flatMap((row) => {
        const provider = modelProviderResponse(row);
        return provider ? [provider] : [];
      }),
    };
  });
}

export function zeroModelProviders(
  orgId: string,
): Computed<Promise<ModelProviderListResponse>> {
  return zeroModelProvidersForUser(orgId, ORG_SENTINEL_USER_ID);
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
 * Non-transactional. A partial failure (secret-delete succeeds,
 * provider-delete fails) would leave an orphan provider row; transactional
 * rewrite is a separate follow-up.
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

    const [provider] = await writeDb
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
      await writeDb.delete(secrets).where(eq(secrets.id, provider.secretId));
      signal.throwIfAborted();
    } else {
      if (provider.authMethod) {
        const secretNames = getSecretNamesForAuthMethod(
          args.type,
          provider.authMethod,
        );
        if (secretNames && secretNames.length > 0) {
          await writeDb
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
      await writeDb
        .delete(modelProviders)
        .where(eq(modelProviders.id, provider.id));
      signal.throwIfAborted();
    }

    return undefined;
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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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

interface MultiAuthMetadata {
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
}

type MultiAuthInsertValues = typeof modelProviders.$inferInsert;

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
    updatedAt: nowDate(),
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
  base.needsReconnect = false;
  base.lastRefreshErrorCode = null;
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
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
    readonly value: string;
    readonly description: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(
    args.value,
    args.featureSwitchContext,
  );
  await writeDb
    .insert(secrets)
    .values({
      userId: args.userId,
      name: args.name,
      encryptedValue,
      type: "model-provider",
      description: args.description,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
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
      readonly type: ModelProviderType;
      readonly secret: string;
      readonly selectedModel?: string;
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

    const secretName = getSecretNameForType(args.type);
    if (!secretName) {
      return badRequestMessage(
        `Provider "${args.type}" does not have a secret name`,
      );
    }

    const writeDb = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

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
      })
      .onConflictDoUpdate({
        target: [
          modelProviders.orgId,
          modelProviders.userId,
          modelProviders.type,
        ],
        set: {
          secretId: upsertedSecret.id,
          selectedModel: args.selectedModel ?? null,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!provider) {
      throw new Error("Expected model provider upsert to return a row");
    }

    const wasCreated = !existingProvider;

    return {
      provider: toModelProviderInfo({
        id: provider.id,
        userId: args.userId,
        type: args.type,
        secretName,
        isDefault: provider.isDefault,
        selectedModel: provider.selectedModel,
        tokenExpiresAt: provider.tokenExpiresAt,
        needsReconnect: provider.needsReconnect,
        lastRefreshErrorCode: provider.lastRefreshErrorCode,
        workspaceName: provider.workspaceName,
        planType: provider.planType,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      }),
      created: wasCreated,
    };
  },
);

/**
 * Loop over `secretValues` and persist each via `upsertMultiAuthSecret`.
 * Extracted so the Command body stays under the per-function lint ceiling.
 */
async function persistMultiAuthSecrets(
  writeDb: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly authMethod: string;
    readonly secretValues: Record<string, string>;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<void> {
  const description = `${MODEL_PROVIDER_TYPES[args.type].label} secret (${args.authMethod})`;
  for (const [name, value] of Object.entries(args.secretValues)) {
    await upsertMultiAuthSecret(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      name,
      value,
      description,
      featureSwitchContext: args.featureSwitchContext,
    });
    signal.throwIfAborted();
  }
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
    if (config.required && !args.secretValues[name]) {
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
      readonly metadata?: MultiAuthMetadata;
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

    L.debug("upserting multi-auth model provider", {
      orgId: args.orgId,
      type: args.type,
      authMethod: args.authMethod,
      secretNames: Object.keys(args.secretValues),
    });

    // Check if model provider already exists (needed for auth method switch cleanup).
    const [existingProvider] = await writeDb
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
      await cleanupOldAuthMethodSecrets(writeDb, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        oldAuthMethod: existingProvider.authMethod ?? "",
        newSecretNames: Object.keys(args.secretValues),
      });
      signal.throwIfAborted();
    }

    // Store/update all secrets atomically.
    const secretNames = Object.keys(args.secretValues);
    await persistMultiAuthSecrets(
      writeDb,
      { ...args, featureSwitchContext },
      signal,
    );

    // Atomic model provider upsert; metadata-aware conflict set clears stale flags.
    const insertValues = buildMultiAuthInsertValues({
      type: args.type,
      userId: args.userId,
      authMethod: args.authMethod,
      selectedModel: args.selectedModel,
      orgId: args.orgId,
      metadata: args.metadata,
    });
    const conflictSet = buildMultiAuthConflictSet(
      args.authMethod,
      args.selectedModel,
      args.metadata,
    );
    const [provider] = await writeDb
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

    const wasCreated = !existingProvider;

    return {
      provider: toModelProviderInfo({
        id: provider.id,
        userId: args.userId,
        type: args.type,
        authMethod: args.authMethod,
        secretNames,
        isDefault: provider.isDefault,
        selectedModel: provider.selectedModel,
        tokenExpiresAt: provider.tokenExpiresAt,
        needsReconnect: provider.needsReconnect,
        lastRefreshErrorCode: provider.lastRefreshErrorCode,
        workspaceName: provider.workspaceName,
        planType: provider.planType,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      }),
      created: wasCreated,
    };
  },
);

export const upsertOrgModelProvider$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly type: ModelProviderType;
      readonly secret: string;
      readonly selectedModel?: string;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      upsertUserModelProvider$,
      {
        orgId: args.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
        secret: args.secret,
        selectedModel: args.selectedModel,
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
      readonly metadata?: MultiAuthMetadata;
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
      provider: toModelProviderInfo({
        id: provider.id,
        userId: ORG_SENTINEL_USER_ID,
        type: args.type,
        isDefault: provider.isDefault,
        selectedModel: provider.selectedModel,
        tokenExpiresAt: provider.tokenExpiresAt,
        needsReconnect: provider.needsReconnect,
        lastRefreshErrorCode: provider.lastRefreshErrorCode,
        workspaceName: provider.workspaceName,
        planType: provider.planType,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      }),
      created: !existingProvider,
    };
  },
);
