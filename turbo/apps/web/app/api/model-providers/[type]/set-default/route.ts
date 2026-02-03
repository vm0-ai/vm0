import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersSetDefaultContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { setModelProviderDefault } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersSetDefaultContract, {
  /**
   * POST /api/model-providers/:type/set-default - Set model provider as default
   */
  setDefault: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("setting model provider as default", {
      userId,
      type: params.type,
    });

    try {
      const provider = await setModelProviderDefault(userId, params.type);

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

const handler = createHandler(modelProvidersSetDefaultContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as POST };
