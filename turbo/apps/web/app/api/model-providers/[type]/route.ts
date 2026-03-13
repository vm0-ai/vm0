import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { modelProvidersByTypeContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
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
    const { userId } = authCtx;

    log.debug("deleting model provider", { userId, type: params.type });

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(userId, orgSlug);
      await deleteModelProvider(org.orgId, userId, params.type);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersByTypeContract, router);

export { handler as DELETE };
