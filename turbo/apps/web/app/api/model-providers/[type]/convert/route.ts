import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../../../src/lib/ts-rest-handler";
import { modelProvidersConvertContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { convertCredentialToModelProvider } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound, isBadRequest } from "../../../../../src/lib/errors";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersConvertContract, {
  /**
   * POST /api/model-providers/:type/convert - Convert user credential to model provider
   */
  convert: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("converting credential to model provider", {
      userId,
      type: params.type,
    });

    try {
      const provider = await convertCredentialToModelProvider(
        userId,
        params.type,
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
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(modelProvidersConvertContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as POST };
