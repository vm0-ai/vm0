import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import {
  hasAuthMethods,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  listUserModelProviders,
  upsertUserModelProvider,
  upsertUserMultiAuthModelProvider,
} from "../../../../../src/lib/zero/model-provider/model-provider-service";
import {
  handleCodexAuthJsonPaste,
  serializeUpsertedProvider,
} from "../../../../../src/lib/zero/model-provider/codex-auth-json-paste-handler";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { isBadRequest } from "@vm0/api-services/errors";

const log = logger("api:zero-me-model-providers");

function isPersonalProviderApiEnabled(
  params: Parameters<typeof isFeatureEnabled>[1],
): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.PersonalModelProvider, params) ||
    isFeatureEnabled(FeatureSwitchKey.ModelFirstModelProvider, params)
  );
}

function isModelFirstPersonalProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

const router = tsr.router(zeroPersonalModelProvidersMainContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const overrides = await loadFeatureSwitchOverrides(
      org.orgId,
      authCtx.userId,
    );
    const personalEnabled = isPersonalProviderApiEnabled({
      userId: authCtx.userId,
      orgId: org.orgId,
      overrides,
    });
    if (!personalEnabled) {
      return createErrorResponse("NOT_FOUND", "Not found");
    }

    const providers = await listUserModelProviders(org.orgId, authCtx.userId);
    const visibleProviders = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProvider,
      { userId: authCtx.userId, orgId: org.orgId, overrides },
    )
      ? providers
      : providers.filter((provider) => {
          return isModelFirstPersonalProviderType(provider.type);
        });

    return {
      status: 200 as const,
      body: {
        modelProviders: visibleProviders.map((p) => {
          return {
            id: p.id,
            type: p.type,
            framework: p.framework,
            secretName: p.secretName,
            authMethod: p.authMethod ?? null,
            secretNames: p.secretNames ?? null,
            isDefault: p.isDefault,
            selectedModel: p.selectedModel,
            workspaceName: p.workspaceName,
            planType: p.planType,
            needsReconnect: p.needsReconnect,
            lastRefreshErrorCode: p.lastRefreshErrorCode,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          };
        }),
      },
    };
  },

  upsert: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const overrides = await loadFeatureSwitchOverrides(
      org.orgId,
      authCtx.userId,
    );
    const personalEnabled = isPersonalProviderApiEnabled({
      userId: authCtx.userId,
      orgId: org.orgId,
      overrides,
    });
    if (!personalEnabled) {
      return createErrorResponse("NOT_FOUND", "Not found");
    }

    const { type, secret, authMethod, secrets, selectedModel } = body;
    const fullPersonalProviderEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProvider,
      { userId: authCtx.userId, orgId: org.orgId, overrides },
    );
    if (
      !fullPersonalProviderEnabled &&
      !isModelFirstPersonalProviderType(type)
    ) {
      return createErrorResponse("NOT_FOUND", `Provider "${type}" not found`);
    }

    if (type === "openai-api-key") {
      const codexBetaEnabled = isFeatureEnabled(FeatureSwitchKey.CodexBeta, {
        userId: authCtx.userId,
        orgId: org.orgId,
        overrides,
      });
      if (!codexBetaEnabled) {
        return createErrorResponse("NOT_FOUND", `Provider "${type}" not found`);
      }
    }

    if (type === "codex-oauth-token" && authMethod === "auth_json") {
      const eligible = isFeatureEnabled(FeatureSwitchKey.CodexOauthProvider, {
        orgId: org.orgId,
        userId: authCtx.userId,
        overrides,
      });
      if (!eligible) {
        return createErrorResponse("NOT_FOUND", `Provider "${type}" not found`);
      }
      const raw = secrets?.CODEX_AUTH_JSON;
      if (!raw) {
        return createErrorResponse(
          "BAD_REQUEST",
          "Missing CODEX_AUTH_JSON secret",
        );
      }
      return handleCodexAuthJsonPaste({
        scope: "personal",
        orgId: org.orgId,
        userId: authCtx.userId,
        rawAuthJson: raw,
        selectedModel,
        upsert: ({
          authMethod: pasteAuthMethod,
          secretValues,
          selectedModel: model,
          metadata,
        }) => {
          return upsertUserMultiAuthModelProvider(
            org.orgId,
            authCtx.userId,
            "codex-oauth-token",
            pasteAuthMethod,
            secretValues,
            model,
            metadata,
          );
        },
      });
    }

    log.debug("upserting personal model provider", {
      orgId: org.orgId,
      userId: authCtx.userId,
      type,
      selectedModel,
    });

    try {
      let provider;
      let created: boolean;

      if (hasAuthMethods(type)) {
        if (!authMethod || !secrets) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Provider "${type}" requires authMethod and secrets`,
          );
        }
        const result = await upsertUserMultiAuthModelProvider(
          org.orgId,
          authCtx.userId,
          type,
          authMethod,
          secrets,
          selectedModel,
        );
        provider = result.provider;
        created = result.created;
      } else {
        if (!secret) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Provider "${type}" requires a secret`,
          );
        }
        const result = await upsertUserModelProvider(
          org.orgId,
          authCtx.userId,
          type,
          secret,
          selectedModel,
        );
        provider = result.provider;
        created = result.created;
      }

      return {
        status: (created ? 201 : 200) as 200 | 201,
        body: {
          provider: serializeUpsertedProvider(provider),
          created,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroPersonalModelProvidersMainContract, router, {
  routeName: "zero.me.model-providers",
});

export { handler as GET, handler as POST };
