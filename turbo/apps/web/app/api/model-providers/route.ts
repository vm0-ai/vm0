import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import {
  modelProvidersMainContract,
  createErrorResponse,
  hasAuthMethods,
} from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../src/lib/scope/resolve-scope";
import {
  listModelProviders,
  upsertModelProvider,
  upsertMultiAuthModelProvider,
} from "../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../src/lib/logger";
import { isBadRequest } from "../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersMainContract, {
  /**
   * GET /api/model-providers - List all model providers
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const scopeSlug = new URL(request.url).searchParams.get("scope");
    const { scope } = await resolveScope(userId, scopeSlug);
    const providers = await listModelProviders(scope.id, userId);

    return {
      status: 200 as const,
      body: {
        modelProviders: providers.map((p) => ({
          id: p.id,
          type: p.type,
          framework: p.framework,
          secretName: p.secretName,
          authMethod: p.authMethod ?? null,
          secretNames: p.secretNames ?? null,
          isDefault: p.isDefault,
          selectedModel: p.selectedModel,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/model-providers - Create or update a model provider
   */
  upsert: async ({ body, headers }, { request }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { type, secret, authMethod, secrets, selectedModel } = body;

    log.debug("upserting model provider", { userId, type, selectedModel });

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const { scope } = await resolveScope(userId, scopeSlug);

      // Determine if this is a multi-auth provider or legacy provider
      const isMultiAuth = hasAuthMethods(type);

      let provider;
      let created: boolean;

      if (isMultiAuth) {
        // Multi-auth provider (e.g., aws-bedrock)
        if (!authMethod || !secrets) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Provider "${type}" requires authMethod and secrets`,
          );
        }
        const result = await upsertMultiAuthModelProvider(
          scope.id,
          userId,
          type,
          authMethod,
          secrets,
          selectedModel,
        );
        provider = result.provider;
        created = result.created;
      } else {
        // Legacy single-secret provider
        if (!secret) {
          return createErrorResponse(
            "BAD_REQUEST",
            `Provider "${type}" requires a secret`,
          );
        }
        const result = await upsertModelProvider(
          scope.id,
          userId,
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
            createdAt: provider.createdAt.toISOString(),
            updatedAt: provider.updatedAt.toISOString(),
          },
          created,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersMainContract, router);

export { handler as GET, handler as PUT };
