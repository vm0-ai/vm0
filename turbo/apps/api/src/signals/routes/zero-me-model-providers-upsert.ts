import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  hasAuthMethods,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  upsertUserModelProvider$,
  upsertUserMultiAuthModelProvider$,
  type ModelProviderInfo,
} from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const featureDisabled = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({ message: "Not found", code: "NOT_FOUND" }),
  }),
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

function isModelFirstPersonalProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function isPersonalProviderApiEnabled(
  params: Parameters<typeof isFeatureEnabled>[1],
): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.PersonalModelProvider, params) ||
    isFeatureEnabled(FeatureSwitchKey.ModelFirstModelProvider, params)
  );
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

const upsertInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();

  // Gate 1: PersonalModelProvider OR ModelFirstModelProvider
  const featureCtx = {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  };
  if (!isPersonalProviderApiEnabled(featureCtx)) {
    return featureDisabled;
  }

  // Body parse
  const bodyResult = await get(
    bodyResultOf(zeroPersonalModelProvidersMainContract.upsert),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { type, secret, authMethod, secrets, selectedModel } = bodyResult.data;

  const fullPersonalProviderEnabled = isFeatureEnabled(
    FeatureSwitchKey.PersonalModelProvider,
    featureCtx,
  );

  // Gate 2: non-model-first type when only ModelFirstModelProvider on
  if (!fullPersonalProviderEnabled && !isModelFirstPersonalProviderType(type)) {
    return providerNotFound(type);
  }

  // Gate 3: openai-api-key requires CodexBeta
  if (type === "openai-api-key") {
    if (!isFeatureEnabled(FeatureSwitchKey.CodexBeta, featureCtx)) {
      return providerNotFound(type);
    }
  }

  // Branch 1: codex-oauth-token + auth_json paste flow
  if (type === "codex-oauth-token" && authMethod === "auth_json") {
    // Gate 4: CodexOauthProvider
    if (!isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, featureCtx)) {
      return providerNotFound(type);
    }
    const raw = secrets?.CODEX_AUTH_JSON;
    if (!raw) {
      return badRequestMessage("Missing CODEX_AUTH_JSON secret");
    }
    return await handleCodexAuthJsonPaste({
      scope: "personal",
      orgId: auth.orgId,
      userId: auth.userId,
      rawAuthJson: raw,
      selectedModel,
      upsert: async (pasteArgs) => {
        const result = await set(
          upsertUserMultiAuthModelProvider$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            type: "codex-oauth-token",
            authMethod: pasteArgs.authMethod,
            secretValues: pasteArgs.secretValues,
            selectedModel: pasteArgs.selectedModel,
            metadata: pasteArgs.metadata,
          },
          signal,
        );
        if ("status" in result) {
          // Defensive guard: the parsed paste produces well-formed inputs and
          // codex-oauth-token has a known auth method config — this branch
          // shouldn't fire. Surface as a typed Error so the paste handler's
          // outer try/catch propagates it as a 500.
          throw new Error(
            "upsertUserMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex paste",
          );
        }
        return result;
      },
    });
  }

  // Branch 2: multi-auth provider
  if (hasAuthMethods(type)) {
    if (!authMethod || !secrets) {
      return badRequestMessage(
        `Provider "${type}" requires authMethod and secrets`,
      );
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
    if ("status" in result) {
      return result;
    }
    return shapeUpsertResult(result.provider, result.created);
  }

  // Branch 3: single-secret provider
  if (!secret) {
    return badRequestMessage(`Provider "${type}" requires a secret`);
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
  if ("status" in result) {
    return result;
  }
  return shapeUpsertResult(result.provider, result.created);
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
