import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  getConnector,
  deleteConnector,
} from "../../../../../src/lib/zero/connector/connector-service";
import { isNotFound } from "@vm0/api-services/errors";

const router = tsr.router(zeroConnectorsByTypeContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "connector:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const connector = await getConnector(org.orgId, userId, params.type);

    if (!connector) {
      return createErrorResponse("NOT_FOUND", "Connector not found");
    }

    return {
      status: 200 as const,
      body: connector,
    };
  },
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const { org } = await resolveOrg(authCtx);
      await deleteConnector(org.orgId, userId, params.type);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Connector not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroConnectorsByTypeContract, router, {
  routeName: "zero.connectors.byType",
});

export { handler as GET, handler as DELETE };
