import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import {
  hasAuthMethods,
  type ModelProviderType,
  type ModelProviderFramework,
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
  parseCodexAuthJson,
  isCodexAuthJsonShapeError,
  isCodexAuthJsonFreePlanError,
} from "../../../../../src/lib/zero/model-provider/codex-auth-json-parser";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { isBadRequest } from "@vm0/api-services/errors";

const log = logger("api:zero-me-model-providers");

interface UpsertedProvider {
  id: string;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  secretName: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  workspaceName: string | null;
  planType: string | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeProvider(provider: UpsertedProvider) {
  return {
    id: provider.id,
    type: provider.type,
    framework: provider.framework,
    secretName: provider.secretName,
    authMethod: provider.authMethod ?? null,
    secretNames: provider.secretNames ?? null,
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

/**
 * Handle the codex-oauth-token + auth_json paste-based connect flow for the
 * personal scope. Mirrors the org-side `handleCodexAuthJsonPaste` in
 * `app/api/zero/model-providers/route.ts` — parses the raw ~/.codex/auth.json
 * server-side and persists the four derived CHATGPT_* fields. The raw
 * CODEX_AUTH_JSON blob is NEVER persisted (per Epic #11974 / #7365).
 */
async function handleCodexAuthJsonPastePersonal(args: {
  orgId: string;
  userId: string;
  rawAuthJson: string;
  selectedModel: string | undefined;
}) {
  try {
    const parsed = parseCodexAuthJson(args.rawAuthJson);

    const { provider, created } = await upsertUserMultiAuthModelProvider(
      args.orgId,
      args.userId,
      "codex-oauth-token",
      "auth_json",
      {
        CHATGPT_ACCESS_TOKEN: parsed.accessToken,
        CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
        CHATGPT_ACCOUNT_ID: parsed.accountId,
        CHATGPT_ID_TOKEN: parsed.idToken,
      },
      args.selectedModel,
      {
        tokenExpiresAt: parsed.tokenExpiresAt,
        workspaceName: parsed.workspaceName,
        planType: parsed.planType,
      },
    );

    log.info("personal codex provider connected via auth_json paste", {
      orgId: args.orgId,
      userId: args.userId,
      workspaceName: parsed.workspaceName,
      planType: parsed.planType,
    });

    return {
      status: (created ? 201 : 200) as 200 | 201,
      body: { provider: serializeProvider(provider), created },
    };
  } catch (error) {
    if (isCodexAuthJsonFreePlanError(error)) {
      log.info("rejected personal codex auth_json paste: free plan", {
        orgId: args.orgId,
        userId: args.userId,
      });
      return createErrorResponse(
        "CODEX_FREE_PLAN_REJECTED",
        "ChatGPT free plan is not supported — upgrade to Plus or higher.",
      );
    }
    if (isCodexAuthJsonShapeError(error)) {
      log.warn("rejected personal codex auth_json paste: shape", {
        orgId: args.orgId,
        userId: args.userId,
        errorMessage: error.message,
      });
      return createErrorResponse(
        "CODEX_AUTH_JSON_SHAPE_INVALID",
        error.message,
      );
    }
    throw error;
  }
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
    const personalEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProvider,
      { userId: authCtx.userId, orgId: org.orgId, overrides },
    );
    if (!personalEnabled) {
      return createErrorResponse("NOT_FOUND", "Not found");
    }

    const providers = await listUserModelProviders(org.orgId, authCtx.userId);

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

    const { org } = await resolveOrg(authCtx);

    const overrides = await loadFeatureSwitchOverrides(
      org.orgId,
      authCtx.userId,
    );
    const personalEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProvider,
      { userId: authCtx.userId, orgId: org.orgId, overrides },
    );
    if (!personalEnabled) {
      return createErrorResponse("NOT_FOUND", "Not found");
    }

    const { type, secret, authMethod, secrets, selectedModel } = body;

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
      return handleCodexAuthJsonPastePersonal({
        orgId: org.orgId,
        userId: authCtx.userId,
        rawAuthJson: raw,
        selectedModel,
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
          provider: {
            id: provider.id,
            type: provider.type,
            framework: provider.framework,
            secretName: provider.secretName,
            authMethod: provider.authMethod ?? null,
            secretNames: provider.secretNames ?? null,
            isDefault: provider.isDefault,
            selectedModel: provider.selectedModel,
            workspaceName: provider.workspaceName,
            planType: provider.planType,
            needsReconnect: provider.needsReconnect,
            lastRefreshErrorCode: provider.lastRefreshErrorCode,
            createdAt: provider.createdAt.toISOString(),
            updatedAt: provider.updatedAt.toISOString(),
          },
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
