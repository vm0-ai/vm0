import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { connectorsMainContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { listConnectors } from "../../../src/lib/connector/connector-service";

const router = tsr.router(connectorsMainContract, {
  /**
   * GET /api/connectors - List all connectors
   */
  list: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const connectorList = await listConnectors(userId);

    return {
      status: 200 as const,
      body: {
        connectors: connectorList,
      },
    };
  },
});

const handler = createHandler(connectorsMainContract, router);

export { handler as GET };
