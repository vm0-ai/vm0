import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroRunsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getRunById } from "../../../../../src/lib/infra/run/run-service";

const router = tsr.router(zeroRunsByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const run = await getRunById(params.id, userId, org.orgId);
    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    return { status: 200 as const, body: run };
  },
});

const handler = createHandler(zeroRunsByIdContract, router, {
  routeName: "zero.runs.byId",
});

export { handler as GET };
