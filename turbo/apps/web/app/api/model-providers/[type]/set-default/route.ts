import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersSetDefaultContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { setModelProviderDefault } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersSetDefaultContract, {
  /**
   * POST /api/model-providers/:type/set-default - Set model provider as default
   */
  setDefault: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    log.debug("setting model provider as default", {
      userId,
      type: params.type,
    });

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const orgParam = new URL(request.url).searchParams.get("org");
      const { scope } = await resolveScope(
        userId,
        scopeSlug,
        orgParam,
        tokenScopeId,
      );
      const provider = await setModelProviderDefault(
        scope.orgId,
        userId,
        params.type,
      );

      return {
        status: 200 as const,
        body: {
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
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersSetDefaultContract, router);

export { handler as POST };
