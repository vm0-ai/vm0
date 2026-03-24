import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroComputerConnectorContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getConnector } from "../../../../../src/lib/connector/connector-service";
import {
  createComputerConnector,
  deleteComputerConnector,
} from "../../../../../src/lib/computer-connector/computer-connector-service";
import {
  isBadRequest,
  isConflict,
  isNotFound,
} from "../../../../../src/lib/errors";

const router = tsr.router(zeroComputerConnectorContract, {
  create: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
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

  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);
    const connector = await getConnector(org.orgId, userId, "computer");

    if (!connector) {
      return createErrorResponse("NOT_FOUND", "Computer connector not found");
    }

    return { status: 200 as const, body: connector };
  },

  delete: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org } = await resolveOrg(authCtx, orgSlug);
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

const handler = createHandler(zeroComputerConnectorContract, router, {
  errorHandler: createSafeErrorHandler("zero-connectors:computer"),
});

export { handler as GET, handler as POST, handler as DELETE };
