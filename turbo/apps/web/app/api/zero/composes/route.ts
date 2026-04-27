import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroComposesMainContract } from "@vm0/api-contracts/contracts/zero-composes";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { getComposeByName } from "../../../../src/lib/infra/agent-compose/compose-service";
import {
  isNotFound,
  isForbidden,
  isBadRequest,
} from "@vm0/api-services/errors";

const router = tsr.router(zeroComposesMainContract, {
  getByName: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error) || isBadRequest(error)) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Agent compose not found: ${query.name}`,
              code: "NOT_FOUND",
            },
          },
        };
      }
      throw error;
    }

    const compose = await getComposeByName(orgId, query.name);
    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent compose not found: ${query.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    return { status: 200 as const, body: compose };
  },
});

const handler = createHandler(zeroComposesMainContract, router, {
  routeName: "zero.composes",
});

export { handler as GET };
