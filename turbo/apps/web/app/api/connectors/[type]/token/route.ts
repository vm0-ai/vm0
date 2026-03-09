import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { connectorTokenContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { upsertApiTokenConnector } from "../../../../../src/lib/connector/connector-service";
import { isBadRequest } from "../../../../../src/lib/errors";

const router = tsr.router(connectorTokenContract, {
  /**
   * POST /api/connectors/:type/token - Submit API token
   */
  submit: async ({ params, body, headers }, { request }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      const scopeSlug = new URL(request.url).searchParams.get("scope");
      const { scope } = await resolveScope(userId, scopeSlug);
      const { connector } = await upsertApiTokenConnector(
        scope.id,
        userId,
        params.type,
        body.secrets,
      );

      return {
        status: 200 as const,
        body: connector,
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse(
          "BAD_REQUEST",
          error instanceof Error ? error.message : "Invalid request",
        );
      }
      throw error;
    }
  },
});

const handler = createHandler(connectorTokenContract, router);

export { handler as POST };
