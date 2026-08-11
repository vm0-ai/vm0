import { command } from "ccstate";
import {
  getDefaultModel,
  getRetiredRunModelReplacement,
  hasAuthMethods,
  type ModelProviderResponse,
  type ModelProviderType,
  type UpsertModelProviderRequest,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage, modelRetired } from "../../lib/error";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import {
  upsertUserModelProvider$,
  upsertUserMultiAuthModelProvider$,
  type ModelProviderInfo,
} from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route-entry";
import { writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  isPersonalSubscriptionProviderType,
  upsertPersonalModelProviderAccount,
  type PersonalSubscriptionProviderType,
} from "../services/model-provider-account.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";

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

function isModelFirstPersonalProviderType(
  type: ModelProviderType,
): type is PersonalSubscriptionProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function toModelProviderResponse(
  provider: ModelProviderInfo,
): ModelProviderResponse {
  // `provider.type` is statically `ModelProviderType`, so no parse is needed —
  // the response shape is a direct projection of `ModelProviderInfo`.
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

function shapeUpsertResult(
  provider: ModelProviderInfo,
  created: boolean,
): {
  readonly status: 200 | 201;
  readonly body: {
    readonly provider: ModelProviderResponse;
    readonly created: boolean;
  };
} {
  return {
    status: (created ? 201 : 200) as 200 | 201,
    body: { provider: toModelProviderResponse(provider), created },
  };
}

function shapeAccountUpsertResult(
  provider: ModelProviderResponse,
  created: boolean,
) {
  return {
    status: (created ? 201 : 200) as 200 | 201,
    body: { provider, created },
  };
}

const upsertPersonalCodexAuthJson$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly rawAuthJson: string;
      readonly selectedModel: string | undefined;
      readonly accountsEnabled: boolean;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ) => {
    return await handleCodexAuthJsonPaste(
      {
        scope: "personal",
        orgId: args.orgId,
        userId: args.userId,
        rawAuthJson: args.rawAuthJson,
        selectedModel: args.selectedModel,
        upsert: async (pasteArgs) => {
          if (args.accountsEnabled) {
            const result = await upsertPersonalModelProviderAccount(
              {
                db: set(writeDb$),
                orgId: args.orgId,
                userId: args.userId,
                type: "codex-oauth-token",
                authMethod: pasteArgs.authMethod,
                secretValues: pasteArgs.secretValues,
                selectedModel: pasteArgs.selectedModel,
                metadata: pasteArgs.metadata,
                mode: { kind: "replace-active" },
                featureSwitchContext: args.featureSwitchContext,
              },
              signal,
            );
            if ("status" in result) {
              throw new Error(result.body.error.message);
            }
            return result;
          }
          const result = await set(
            upsertUserMultiAuthModelProvider$,
            {
              orgId: args.orgId,
              userId: args.userId,
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
              "upsertUserMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex paste",
            );
          }
          return result;
        },
      },
      signal,
    );
  },
);

const upsertAcceptedPersonalProvider$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly body: UpsertModelProviderRequest & {
        readonly type: PersonalSubscriptionProviderType;
      };
    },
    signal: AbortSignal,
  ) => {
    const auth = args;
    const { type, secret, authMethod, secrets, selectedModel } = args.body;
    const featureSwitchContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const accountsEnabled =
      isPersonalSubscriptionProviderType(type) &&
      isFeatureEnabled(
        FeatureSwitchKey.PersonalModelProviderAccounts,
        featureSwitchContext,
      );

    // Branch 1: codex-oauth-token + auth_json paste flow
    if (type === "codex-oauth-token" && authMethod === "auth_json") {
      const raw = secrets?.CODEX_AUTH_JSON;
      if (!raw) {
        return badRequestMessage("Missing CODEX_AUTH_JSON secret");
      }
      return await set(
        upsertPersonalCodexAuthJson$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          rawAuthJson: raw,
          selectedModel,
          accountsEnabled,
          featureSwitchContext,
        },
        signal,
      );
    }

    // Branch 2: multi-auth provider
    if (hasAuthMethods(type)) {
      if (!authMethod || !secrets) {
        return badRequestMessage(
          `Provider "${type}" requires authMethod and secrets`,
        );
      }
      if (accountsEnabled) {
        const result = await upsertPersonalModelProviderAccount(
          {
            db: set(writeDb$),
            orgId: auth.orgId,
            userId: auth.userId,
            type,
            authMethod,
            secretValues: secrets,
            selectedModel,
            mode: { kind: "replace-active" },
            featureSwitchContext,
          },
          signal,
        );
        signal.throwIfAborted();
        return "status" in result
          ? result
          : shapeAccountUpsertResult(result.provider, result.created);
      }
      const result = await set(
        upsertUserMultiAuthModelProvider$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          type,
          authMethod,
          secretValues: secrets,
          selectedModel,
        },
        signal,
      );
      signal.throwIfAborted();
      return "status" in result
        ? result
        : shapeUpsertResult(result.provider, result.created);
    }

    // Branch 3: single-secret provider
    if (!secret) {
      return badRequestMessage(`Provider "${type}" requires a secret`);
    }
    if (accountsEnabled) {
      const result = await upsertPersonalModelProviderAccount(
        {
          db: set(writeDb$),
          orgId: auth.orgId,
          userId: auth.userId,
          type,
          authMethod: null,
          secretValues: {
            CLAUDE_CODE_OAUTH_TOKEN: secret,
          },
          selectedModel,
          mode: { kind: "replace-active" },
          featureSwitchContext,
        },
        signal,
      );
      signal.throwIfAborted();
      return "status" in result
        ? result
        : shapeAccountUpsertResult(result.provider, result.created);
    }
    const result = await set(
      upsertUserModelProvider$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type,
        secret,
        selectedModel,
      },
      signal,
    );
    signal.throwIfAborted();
    return "status" in result
      ? result
      : shapeUpsertResult(result.provider, result.created);
  },
);

const upsertInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(zeroPersonalModelProvidersMainContract.upsert),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { type, selectedModel } = bodyResult.data;
  if (!isModelFirstPersonalProviderType(type)) {
    return providerNotFound(type);
  }

  const capabilities = await loadOrgPlanCapabilities(set(writeDb$), auth.orgId);
  signal.throwIfAborted();
  const configuredModel = selectedModel ?? getDefaultModel(type) ?? "";
  const replacement = getRetiredRunModelReplacement(configuredModel, {
    restrictedVm0Models:
      capabilities?.status === "active" && capabilities.restrictedVm0Models,
    modelProviderType: type,
  });
  if (replacement) {
    return modelRetired(configuredModel, replacement);
  }
  return await set(
    upsertAcceptedPersonalProvider$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      body: { ...bodyResult.data, type },
    },
    signal,
  );
});

export const zeroMeModelProvidersUpsertRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersMainContract.upsert,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      upsertInner$,
    ),
  },
];
