import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroVariablesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { setVariable } from "../../../../src/lib/variable/variable-service";
import { logger } from "../../../../src/lib/logger";
import { isBadRequest } from "../../../../src/lib/errors";

const log = logger("api:zero-variables");

const router = tsr.router(zeroVariablesContract, {
  set: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { name, value, description } = body;

    log.debug("setting variable", { userId, name });

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
      const variable = await setVariable(
        org.orgId,
        userId,
        name,
        value,
        description,
      );

      return {
        status: 200 as const,
        body: {
          id: variable.id,
          name: variable.name,
          value: variable.value,
          description: variable.description,
          createdAt: variable.createdAt.toISOString(),
          updatedAt: variable.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroVariablesContract, router, {
  errorHandler: createSafeErrorHandler("zero-variables"),
});

export { handler as POST };
