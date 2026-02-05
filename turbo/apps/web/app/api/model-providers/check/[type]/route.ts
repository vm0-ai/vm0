import {
  createHandler,
  tsr,
  validationErrorHandler,
} from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersCheckContract,
  createErrorResponse,
  getSecretNameForType,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { checkSecretExists } from "../../../../../src/lib/model-provider/model-provider-service";

const router = tsr.router(modelProvidersCheckContract, {
  /**
   * GET /api/model-providers/check/:type - Check if secret exists
   */
  check: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const result = await checkSecretExists(userId, params.type);

    return {
      status: 200 as const,
      body: {
        exists: result.exists,
        secretName: getSecretNameForType(params.type) ?? "",
        // Note: currentType is no longer relevant since user and model-provider secrets are isolated
        currentType: result.exists ? "model-provider" : undefined,
      },
    };
  },
});

const handler = createHandler(modelProvidersCheckContract, router, {
  errorHandler: validationErrorHandler,
});

export { handler as GET };
