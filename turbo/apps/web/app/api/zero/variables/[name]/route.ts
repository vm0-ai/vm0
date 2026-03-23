import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroVariablesByNameContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { deleteVariable } from "../../../../../src/lib/variable/variable-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:zero-variables");

const router = tsr.router(zeroVariablesByNameContract, {
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    log.debug("deleting variable", { userId, name: params.name });

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
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
  errorHandler: createSafeErrorHandler("zero-variables"),
});

export { handler as DELETE };
