import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { hasAuthMethods } from "@vm0/api-contracts/contracts/model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  listOrgModelProviders,
  upsertOrgModelProvider,
  upsertOrgMultiAuthModelProvider,
  upsertOrgNoSecretModelProvider,
} from "../../../../src/lib/zero/model-provider/model-provider-service";
import {
  handleCodexAuthJsonPaste,
  serializeUpsertedProvider,
} from "../../../../src/lib/zero/model-provider/codex-auth-json-paste-handler";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";
import { logger } from "../../../../src/lib/shared/logger";
import { isBadRequest } from "@vm0/api-services/errors";

const log = logger("api:zero-model-providers");

const router = tsr.router(zeroModelProvidersMainContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org } = await resolveOrg(authCtx);
    const providers = await listOrgModelProviders(org.orgId);

    return {
      status: 200 as const,
      body: {
        modelProviders: providers.map((p) => {
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
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org model providers",
      );
    }

    const { type, secret, authMethod, secrets } = body;

    if (type === "openai-api-key") {
      const overrides = await loadFeatureSwitchOverrides(
        org.orgId,
        authCtx.userId,
      );
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
      const overrides = await loadFeatureSwitchOverrides(
        org.orgId,
        authCtx.userId,
      );
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
        scope: "org",
        orgId: org.orgId,
        rawAuthJson: raw,
        selectedModel: undefined,
        upsert: ({ authMethod: pasteAuthMethod, secretValues, metadata }) => {
          return upsertOrgMultiAuthModelProvider(
            org.orgId,
            "codex-oauth-token",
            pasteAuthMethod,
            secretValues,
            undefined,
            metadata,
          );
        },
      });
    }

    log.debug("upserting org model provider", {
      orgId: org.orgId,
      type,
    });

    try {
      let provider;
      let created: boolean;

      if (type === "vm0") {
        const result = await upsertOrgNoSecretModelProvider(
          org.orgId,
          type,
          undefined,
        );
        provider = result.provider;
        created = result.created;
      } else if (hasAuthMethods(type)) {
        if (!authMethod || !secrets) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Provider "${type}" requires authMethod and secrets`,
          );
        }
        const result = await upsertOrgMultiAuthModelProvider(
          org.orgId,
          type,
          authMethod,
          secrets,
          undefined,
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
        const result = await upsertOrgModelProvider(
          org.orgId,
          type,
          secret,
          undefined,
        );
        provider = result.provider;
        created = result.created;
      }

      return {
        status: (created ? 201 : 200) as 200 | 201,
        body: { provider: serializeUpsertedProvider(provider), created },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroModelProvidersMainContract, router, {
  routeName: "zero.model-providers",
});

export { handler as GET, handler as POST };
