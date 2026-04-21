import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroCustomConnectorSecretContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import {
  deleteCustomConnectorSecret,
  setCustomConnectorSecret,
} from "../../../../../../src/lib/zero/custom-connector/custom-connector-service";
import {
  isBadRequest,
  isNotFound,
} from "../../../../../../src/lib/shared/errors";

const router = tsr.router(zeroCustomConnectorSecretContract, {
  set: async ({ body, params, headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;
    try {
      const { org } = await resolveOrg(authCtx);
      await setCustomConnectorSecret(org.orgId, userId, params.id, body.value);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Custom connector not found");
      }
      if (isBadRequest(error)) {
        return createErrorResponse(
          "BAD_REQUEST",
          error instanceof Error ? error.message : "Invalid request",
        );
      }
      throw error;
    }
  },

  delete: async ({ params, headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;
    const { org } = await resolveOrg(authCtx);
    await deleteCustomConnectorSecret(org.orgId, userId, params.id);
    return { status: 204 as const, body: undefined };
  },
});

const handler = createHandler(zeroCustomConnectorSecretContract, router, {
  routeName: "zero.custom-connectors.secret",
});

export { handler as PUT, handler as DELETE };
