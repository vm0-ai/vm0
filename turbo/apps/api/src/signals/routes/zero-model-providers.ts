import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  hasAuthMethods,
  type ModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersDefaultContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { badRequestMessage, isNotFoundResponse } from "../../lib/error";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  deleteOrgModelProvider$,
  setOrgModelProviderDefault$,
  upsertOrgModelProvider$,
  upsertOrgMultiAuthModelProvider$,
  upsertOrgNoSecretModelProvider$,
  zeroModelProviders,
  type ModelProviderInfo,
} from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage org model providers",
      code: "FORBIDDEN",
    }),
  }),
});

const listModelProvidersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const result = await get(zeroModelProviders(auth.orgId));
  return { status: 200 as const, body: result };
});

function providerNotFound(type: string) {
  return {
    status: 404 as const,
    body: {
      error: {
        message: `Provider "${type}" not found`,
        code: "NOT_FOUND" as const,
      },
    },
  };
}

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
      bodyResultOf(zeroModelProvidersMainContract.upsert),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { type, secret, authMethod, secrets, selectedModel } =
      bodyResult.data;

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const featureContext = {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    };

    if (
      type === "openai-api-key" &&
      !isFeatureEnabled(FeatureSwitchKey.CodexBeta, featureContext)
    ) {
      return providerNotFound(type);
    }

    if (type === "codex-oauth-token" && authMethod === "auth_json") {
      if (
        !isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, featureContext)
      ) {
        return providerNotFound(type);
      }
      const raw = secrets?.CODEX_AUTH_JSON;
      if (!raw) {
        return badRequestMessage("Missing CODEX_AUTH_JSON secret");
      }
      return await handleCodexAuthJsonPaste({
        scope: "org",
        orgId: auth.orgId,
        rawAuthJson: raw,
        selectedModel,
        upsert: async (pasteArgs) => {
          const result = await set(
            upsertOrgMultiAuthModelProvider$,
            {
              orgId: auth.orgId,
              type: "codex-oauth-token",
              authMethod: pasteArgs.authMethod,
              secretValues: pasteArgs.secretValues,
              selectedModel: pasteArgs.selectedModel,
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
      });
    }

    if (type === "vm0") {
      const result = await set(
        upsertOrgNoSecretModelProvider$,
        { orgId: auth.orgId, type, selectedModel },
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
          selectedModel,
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
      { orgId: auth.orgId, type, secret, selectedModel },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in result) {
      return result;
    }
    return shapeUpsertResult(result.provider, result.created);
  },
);

const setDefaultModelProviderInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const params = await get(
      pathParamsOf(zeroModelProvidersDefaultContract.setDefault),
    );
    signal.throwIfAborted();

    const result = await set(
      setOrgModelProviderDefault$,
      { orgId: auth.orgId, type: params.type },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    return { status: 200 as const, body: toModelProviderResponse(result) };
  },
);

const deleteModelProviderInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const params = await get(
      pathParamsOf(zeroModelProvidersByTypeContract.delete),
    );
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

export const zeroModelProvidersRoutes: readonly RouteEntry[] = [
  {
    route: zeroModelProvidersMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listModelProvidersInner$,
    ),
  },
  {
    route: zeroModelProvidersMainContract.upsert,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      upsertModelProviderInner$,
    ),
  },
  {
    route: zeroModelProvidersDefaultContract.setDefault,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setDefaultModelProviderInner$,
    ),
  },
  {
    route: zeroModelProvidersByTypeContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteModelProviderInner$,
    ),
  },
];
