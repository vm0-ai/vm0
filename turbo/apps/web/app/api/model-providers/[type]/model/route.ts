import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersUpdateModelContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { updateModelProviderModel } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersUpdateModelContract, {
  /**
   * PATCH /api/model-providers/:type/model - Update model selection
   */
  updateModel: async ({ params, body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("updating model provider model", {
      userId,
      type: params.type,
      selectedModel: body.selectedModel,
    });

    try {
      const provider = await updateModelProviderModel(
        userId,
        params.type,
        body.selectedModel,
      );

      return {
        status: 200 as const,
        body: {
          id: provider.id,
          type: provider.type,
          framework: provider.framework,
          credentialName: provider.credentialName,
          authMethod: provider.authMethod ?? null,
          credentialNames: provider.credentialNames ?? null,
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

const handler = createHandler(modelProvidersUpdateModelContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as PATCH };
