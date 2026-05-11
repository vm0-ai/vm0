import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  getComposeById,
  deleteCompose,
} from "../../../../../src/lib/infra/agent-compose/compose-service";
import { isNotFound, isConflict } from "@vm0/api-services/errors";

function unauthorizedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

const router = tsr.router(zeroComposesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return unauthorizedResponse();
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const compose = await getComposeById(params.id, userId, org.orgId);
      return { status: 200 as const, body: compose };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: { error: { message: error.message, code: "NOT_FOUND" } },
        };
      }
      throw error;
    }
  },

  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      await deleteCompose(params.id, userId);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: { error: { message: error.message, code: "NOT_FOUND" } },
        };
      }
      if (isConflict(error)) {
        return {
          status: 409 as const,
          body: { error: { message: error.message, code: "CONFLICT" } },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroComposesByIdContract, router, {
  routeName: "zero.composes.byId",
});

export { handler as GET, handler as DELETE };
