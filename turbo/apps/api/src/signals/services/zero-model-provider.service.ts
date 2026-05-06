import { computed, type Computed } from "ccstate";
import {
  getFrameworkForType,
  getSecretNamesForAuthMethod,
  modelProviderTypeSchema,
  type ModelProviderListResponse,
  type ModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

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
