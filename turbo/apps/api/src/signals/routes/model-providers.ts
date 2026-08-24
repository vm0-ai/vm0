import { command, computed } from "ccstate";
import {
  hasAuthMethods,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  modelProviderCooldownDiagnosticsContract,
  modelProvidersByTypeContract,
  modelProvidersMainContract,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { managedModelCandidateCooldown } from "@okouai/db/schema/managed-model-cooldown";
import { asc, gt, max } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { badRequestMessage, isNotFoundResponse } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import {
  deleteOrgModelProvider$,
  upsertOrgModelProvider$,
  upsertOrgMultiAuthModelProvider$,
  upsertOrgNoSecretModelProvider$,
  modelProviders,
  type ModelProviderInfo,
} from "../services/model-provider.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage org model providers",
      code: "FORBIDDEN",
    }),
  }),
});

const cooldownDiagnosticsDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Managed model cooldown diagnostics are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const listModelProvidersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(modelProviders(auth.orgId));
  return { status: 200 as const, body: result };
});

const getManagedModelCooldownDiagnosticsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const featureStates = getAllFeatureStates({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    });
    if (!featureStates[FeatureSwitchKey.OkouDebug]) {
      return cooldownDiagnosticsDisabled;
    }

    const db = get(db$);
    const timestamp = nowDate();
    const activeCooldownRows = db.$with("active_model_candidate_cooldowns").as(
      unionAll(
        db
          .select({
            selectedModel: managedModelCandidateCooldown.selectedModel,
            providerType: managedModelCandidateCooldown.providerType,
            upstreamModel: managedModelCandidateCooldown.upstreamModel,
            unavailableUntil: managedModelCandidateCooldown.unavailableUntil,
          })
          .from(managedModelCandidateCooldown)
          .where(gt(managedModelCandidateCooldown.unavailableUntil, timestamp)),
        db
          .select({
            selectedModel: builtInModelCandidateCooldown.selectedModel,
            providerType: builtInModelCandidateCooldown.providerType,
            upstreamModel: builtInModelCandidateCooldown.upstreamModel,
            unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
          })
          .from(builtInModelCandidateCooldown)
          .where(gt(builtInModelCandidateCooldown.unavailableUntil, timestamp)),
      ),
    );
    const activeCooldowns = await db
      .with(activeCooldownRows)
      .select({
        selectedModel: activeCooldownRows.selectedModel,
        providerType: activeCooldownRows.providerType,
        upstreamModel: activeCooldownRows.upstreamModel,
        unavailableUntil: max(activeCooldownRows.unavailableUntil)
          .mapWith(managedModelCandidateCooldown.unavailableUntil)
          .as("unavailable_until"),
      })
      .from(activeCooldownRows)
      .groupBy(
        activeCooldownRows.selectedModel,
        activeCooldownRows.providerType,
        activeCooldownRows.upstreamModel,
      )
      .orderBy(
        asc(activeCooldownRows.selectedModel),
        asc(activeCooldownRows.providerType),
        asc(activeCooldownRows.upstreamModel),
      );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        fallbackEnabled:
          featureStates[FeatureSwitchKey.ManagedModelProviderFallback],
        activeCooldowns: activeCooldowns.map((cooldown) => {
          return {
            ...cooldown,
            unavailableUntil: cooldown.unavailableUntil.toISOString(),
          };
        }),
      },
    };
  },
);

function toModelProviderResponse(
  provider: ModelProviderInfo,
): ModelProviderResponse {
  return {
    id: provider.id,
    type: provider.type,
    framework: provider.framework,
    secretName: provider.secretName,
    authMethod: provider.authMethod,
    secretNames: provider.secretNames,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    workspaceName: provider.workspaceName,
    planType: provider.planType,
    subscriptionResetPeriod: provider.subscriptionResetPeriod,
    subscriptionNextResetAt:
      provider.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function shapeUpsertResult(provider: ModelProviderInfo, created: boolean) {
  return {
    status: (created ? 201 : 200) as 200 | 201,
    body: { provider: toModelProviderResponse(provider), created },
  };
}

const upsertModelProviderInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(
      bodyResultOf(modelProvidersMainContract.upsert),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { type, secret, authMethod, secrets } = bodyResult.data;

    if (type === "codex-oauth-token" && authMethod === "auth_json") {
      const raw = secrets?.CODEX_AUTH_JSON;
      if (!raw) {
        return badRequestMessage("Missing CODEX_AUTH_JSON secret");
      }
      return await handleCodexAuthJsonPaste(
        {
          scope: "org",
          orgId: auth.orgId,
          rawAuthJson: raw,
          selectedModel: undefined,
          upsert: async (pasteArgs) => {
            const result = await set(
              upsertOrgMultiAuthModelProvider$,
              {
                orgId: auth.orgId,
                type: "codex-oauth-token",
                authMethod: pasteArgs.authMethod,
                secretValues: pasteArgs.secretValues,
                metadata: pasteArgs.metadata,
              },
              signal,
            );
            if ("status" in result) {
              throw new Error(
                "upsertOrgMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex paste",
              );
            }
            return result;
          },
        },
        signal,
      );
    }

    if (type === "vm0") {
      const result = await set(
        upsertOrgNoSecretModelProvider$,
        { orgId: auth.orgId, type },
        signal,
      );
      signal.throwIfAborted();
      if ("status" in result) {
        return result;
      }
      return shapeUpsertResult(result.provider, result.created);
    }

    if (hasAuthMethods(type)) {
      if (!authMethod || !secrets) {
        return badRequestMessage(
          `Provider "${type}" requires authMethod and secrets`,
        );
      }
      const result = await set(
        upsertOrgMultiAuthModelProvider$,
        {
          orgId: auth.orgId,
          type,
          authMethod,
          secretValues: secrets,
        },
        signal,
      );
      signal.throwIfAborted();
      if ("status" in result) {
        return result;
      }
      return shapeUpsertResult(result.provider, result.created);
    }

    if (!secret) {
      return badRequestMessage(`Provider "${type}" requires a secret`);
    }
    const result = await set(
      upsertOrgModelProvider$,
      { orgId: auth.orgId, type, secret },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in result) {
      return result;
    }
    return shapeUpsertResult(result.provider, result.created);
  },
);

const deleteModelProviderInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const params = await get(pathParamsOf(modelProvidersByTypeContract.delete));
    signal.throwIfAborted();

    const result = await set(
      deleteOrgModelProvider$,
      { orgId: auth.orgId, type: params.type },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    return { status: 204 as const, body: undefined };
  },
);

export const modelProvidersRoutes: readonly RouteEntry[] = [
  {
    route: modelProviderCooldownDiagnosticsContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      getManagedModelCooldownDiagnosticsInner$,
    ),
  },
  {
    route: modelProvidersMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listModelProvidersInner$,
    ),
  },
  {
    route: modelProvidersMainContract.upsert,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      upsertModelProviderInner$,
    ),
  },
  {
    route: modelProvidersByTypeContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteModelProviderInner$,
    ),
  },
];
