import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroVariablesByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { deleteVariable } from "../../../../../src/lib/zero/variable/variable-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { isNotFound } from "@vm0/api-services/errors";

const log = logger("api:zero-variables");

const router = tsr.router(zeroVariablesByNameContract, {
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    log.debug("deleting variable", { userId, name: params.name });

    try {
      const { org } = await resolveOrg(authCtx);
      await deleteVariable(org.orgId, userId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          `Variable "${params.name}" not found`,
        );
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroVariablesByNameContract, router, {
  routeName: "zero.variables.byName",
});

export { handler as DELETE };
