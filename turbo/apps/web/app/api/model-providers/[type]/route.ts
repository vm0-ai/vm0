import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { modelProvidersByTypeContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { deleteModelProvider } from "../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../src/lib/logger";
import { isNotFound } from "../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersByTypeContract, {
  /**
   * DELETE /api/model-providers/:type - Delete a model provider
   */
  delete: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("deleting model provider", { userId, type: params.type });

    try {
      await deleteModelProvider(userId, params.type);

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
