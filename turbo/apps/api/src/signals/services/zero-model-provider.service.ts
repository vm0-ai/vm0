import { command, computed, type Computed } from "ccstate";
import {
  getFrameworkForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type ModelProviderType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq, inArray } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { nowDate } from "../external/time";

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

export function zeroModelProviders(
  orgId: string,
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
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
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

type NotFoundResponse = ReturnType<typeof notFound>;

/**
 * Delete a user-level model provider and cascade-delete its secrets.
 *
 * Mirrors apps/web's `deleteModelProvider` (via `deleteUserModelProvider`):
 *   - Legacy single-secret providers: deleting the secret cascades the
 *     model_provider row via FK (`onDelete: "cascade"` at the schema).
 *   - Multi-auth providers: deletes the per-auth-method secrets by name,
 *     then deletes the model_provider row explicitly.
 *
 * If the deleted row was the user's default provider, promotes the oldest
 * remaining (orgId, userId) provider to default — matches web's invariant
 * that a user always has at most one default and it transitions to a
 * surviving row when the previous default is removed.
 *
 * Non-transactional, matching web. A partial failure (secret-delete
 * succeeds, provider-delete fails) would leave an orphan provider row —
 * web has the same gap; transactional rewrite is a separate follow-up.
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

    const wasDefault = provider.isDefault;

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

    if (wasDefault) {
      const [next] = await writeDb
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
          ),
        )
        .orderBy(modelProviders.createdAt)
        .limit(1);
      signal.throwIfAborted();
      if (next) {
        await writeDb
          .update(modelProviders)
          .set({ isDefault: true, updatedAt: nowDate() })
          .where(eq(modelProviders.id, next.id));
        signal.throwIfAborted();
      }
    }

    return undefined;
  },
);

/**
 * Update a personal model provider's `selectedModel`. Single atomic
 * `UPDATE … RETURNING` keyed on (orgId, userId, type) — strictly fewer
 * round-trips than web's SELECT-then-UPDATE shape.
 *
 * The `secretName` field of the response body comes from a follow-up
 * SELECT against `secrets.id`, only when `secretId` is non-null
 * (multi-auth providers store secret references via `authMethod` and
 * `getSecretNamesForAuthMethod` instead).
 */
export const updateUserModelProviderModel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: ModelProviderType;
      readonly selectedModel: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | NotFoundResponse
    | { readonly status: 200; readonly body: ModelProviderResponse }
  > => {
    const writeDb = set(writeDb$);

    const [updated] = await writeDb
      .update(modelProviders)
      .set({
        selectedModel: args.selectedModel ?? null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.type, args.type),
        ),
      )
      .returning({
        id: modelProviders.id,
        type: modelProviders.type,
        isDefault: modelProviders.isDefault,
        selectedModel: modelProviders.selectedModel,
        authMethod: modelProviders.authMethod,
        secretId: modelProviders.secretId,
        workspaceName: modelProviders.workspaceName,
        planType: modelProviders.planType,
        needsReconnect: modelProviders.needsReconnect,
        lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
        createdAt: modelProviders.createdAt,
        updatedAt: modelProviders.updatedAt,
      });
    signal.throwIfAborted();

    if (!updated) {
      return notFound("Resource not found");
    }

    let secretName: string | null = null;
    if (updated.secretId) {
      const [secret] = await writeDb
        .select({ name: secrets.name })
        .from(secrets)
        .where(eq(secrets.id, updated.secretId))
        .limit(1);
      signal.throwIfAborted();
      secretName = secret?.name ?? null;
    }

    const body = modelProviderResponse({ ...updated, secretName });
    if (!body) {
      return notFound("Resource not found");
    }
    return { status: 200 as const, body };
  },
);
