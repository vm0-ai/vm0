import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { modelProvidersByTypeContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { deleteModelProvider } from "../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../src/lib/logger";
import { isNotFound } from "../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersByTypeContract, {
  /**
   * DELETE /api/model-providers/:type - Delete a model provider
   */
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    log.debug("deleting model provider", { userId, type: params.type });

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const orgParam = new URL(request.url).searchParams.get("org");
      const { scope } = await resolveScope(
        userId,
        scopeSlug,
        orgParam,
        tokenScopeId,
      );
      await deleteModelProvider(scope.orgId, userId, params.type);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersByTypeContract, router);

export { handler as DELETE };
