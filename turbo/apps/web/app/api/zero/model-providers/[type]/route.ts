import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { deleteOrgModelProvider } from "../../../../../src/lib/zero/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const log = logger("api:zero-model-providers");

const router = tsr.router(zeroModelProvidersByTypeContract, {
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org model providers",
      );
    }

    log.debug("deleting org model provider", {
      orgId: org.orgId,
      type: params.type,
    });

    try {
      await deleteOrgModelProvider(org.orgId, params.type);

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

const handler = createHandler(zeroModelProvidersByTypeContract, router, {
  routeName: "zero.model-providers.byType",
});

export { handler as DELETE };
