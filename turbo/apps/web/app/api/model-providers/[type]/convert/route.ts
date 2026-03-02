import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { modelProvidersConvertContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:model-providers");

const router = tsr.router(modelProvidersConvertContract, {
  /**
   * POST /api/model-providers/:type/convert - DEPRECATED
   * Credential conversion is no longer needed since user and model-provider secrets are isolated by type
   */
  convert: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    log.debug("convert endpoint called (deprecated)", {
      userId,
      type: params.type,
    });

    return createErrorResponse(
      "BAD_REQUEST",
      "Credential conversion is no longer needed. User secrets and model provider secrets are now isolated by type. " +
        "Simply configure your model provider directly with `vm0 model-provider setup`.",
    );
  },
});

const handler = createHandler(modelProvidersConvertContract, router);

export { handler as POST };
