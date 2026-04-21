import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroVariablesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  listVariables,
  setVariable,
} from "../../../../src/lib/zero/variable/variable-service";
import { logger } from "../../../../src/lib/shared/logger";
import { isBadRequest } from "../../../../src/lib/shared/errors";

const log = logger("api:zero-variables");

const router = tsr.router(zeroVariablesContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const vars = await listVariables(org.orgId, userId);

    return {
      status: 200 as const,
      body: {
        variables: vars.map((v) => {
          return {
            id: v.id,
            name: v.name,
            value: v.value,
            description: v.description,
            createdAt: v.createdAt.toISOString(),
            updatedAt: v.updatedAt.toISOString(),
          };
        }),
      },
    };
  },

  set: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { name, value, description } = body;

    log.debug("setting variable", { userId, name });

    try {
      const { org } = await resolveOrg(authCtx);
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
  routeName: "zero.variables",
});

export { handler as GET, handler as POST };
