import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { listComposes } from "../../../../../src/lib/zero/zero-compose-service";
import { isNotFound, isForbidden } from "@vm0/api-services/errors";

function invalidRequestResponse() {
  return {
    status: 400 as const,
    body: {
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    },
  };
}

const router = tsr.router(zeroComposesListContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return invalidRequestResponse();

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error)) {
        return invalidRequestResponse();
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: {
            error: {
              message: "You don't have access to this org",
              code: "FORBIDDEN",
            },
          },
        };
      }
      throw error;
    }

    const result = await listComposes(orgId);
    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroComposesListContract, router, {
  routeName: "zero.composes.list",
});

export { handler as GET };
