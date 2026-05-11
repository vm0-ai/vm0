import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { deleteUserModelProvider } from "../../../../../../src/lib/zero/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/shared/logger";
import { isNotFound } from "@vm0/api-services/errors";

const log = logger("api:zero-me-model-providers");

const router = tsr.router(zeroPersonalModelProvidersByTypeContract, {
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org } = await resolveOrg(authCtx);

    log.debug("deleting personal model provider", {
      orgId: org.orgId,
      userId: authCtx.userId,
      type: params.type,
    });

    try {
      await deleteUserModelProvider(org.orgId, authCtx.userId, params.type);

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

const handler = createHandler(
  zeroPersonalModelProvidersByTypeContract,
  router,
  {
    routeName: "zero.me.model-providers.byType",
  },
);

export { handler as DELETE };
