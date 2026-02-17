import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { connectorsByTypeContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  getConnector,
  deleteConnector,
} from "../../../../src/lib/connector/connector-service";
import { isNotFound } from "../../../../src/lib/errors";

const router = tsr.router(connectorsByTypeContract, {
  /**
   * GET /api/connectors/:type - Get connector status
   */
  get: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const connector = await getConnector(userId, params.type);

    if (!connector) {
      return createErrorResponse("NOT_FOUND", "Connector not found");
    }

    return {
      status: 200 as const,
      body: connector,
    };
  },

  /**
   * DELETE /api/connectors/:type - Disconnect connector
   */
  delete: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      await deleteConnector(userId, params.type);

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

const handler = createHandler(connectorsByTypeContract, router);

export { handler as GET, handler as DELETE };
