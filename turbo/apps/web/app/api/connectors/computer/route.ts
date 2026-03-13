import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { computerConnectorContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { getConnector } from "../../../../src/lib/connector/connector-service";
import {
  createComputerConnector,
  deleteComputerConnector,
} from "../../../../src/lib/computer-connector/computer-connector-service";
import {
  isBadRequest,
  isConflict,
  isNotFound,
} from "../../../../src/lib/errors";

const router = tsr.router(computerConnectorContract, {
  /**
   * POST /api/connectors/computer - Create computer connector
   */
  create: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("scope");
      const orgParam = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(userId, orgSlug, orgParam, tokenOrgId);
      const result = await createComputerConnector(org.orgId, userId);
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      if (isConflict(error)) {
        return createErrorResponse("CONFLICT", "Resource conflict");
      }
      throw error;
    }
  },

  /**
   * GET /api/connectors/computer - Get computer connector status
   */
  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("scope");
    const orgParam = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(userId, orgSlug, orgParam, tokenOrgId);
    const connector = await getConnector(org.orgId, userId, "computer");
    if (!connector) {
      return createErrorResponse("NOT_FOUND", "Computer connector not found");
    }

    return { status: 200 as const, body: connector };
  },

  /**
   * DELETE /api/connectors/computer - Delete computer connector
   */
  delete: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("scope");
      const orgParam = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(userId, orgSlug, orgParam, tokenOrgId);
      await deleteComputerConnector(org.orgId, userId);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Computer connector not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(computerConnectorContract, router);

export { handler as GET, handler as POST, handler as DELETE };
