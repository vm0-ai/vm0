import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { composesListContract } from "@vm0/core/contracts/composes";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { listComposes } from "../../../../../src/lib/zero/zero-compose-service";
import { isNotFound, isForbidden } from "../../../../../src/lib/shared/errors";

const router = tsr.router(composesListContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org: resolvedOrg } = await resolveOrg(authCtx);
      orgId = resolvedOrg.orgId;
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: "Invalid request", code: "BAD_REQUEST" },
          },
        };
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

const handler = createHandler(composesListContract, router, {
  routeName: "agent.composes.list",
});

export { handler as GET };
