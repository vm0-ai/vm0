import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import { orgTierSchema } from "@vm0/api-contracts/contracts/orgs";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getRunQueueStatus } from "../../../../../src/lib/zero/zero-run-queue-service";

const router = tsr.router(zeroRunsQueueContract, {
  getQueue: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const orgTier = orgTierSchema.parse(org.tier);

    const result = await getRunQueueStatus(userId, org.orgId, orgTier);
    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroRunsQueueContract, router, {
  routeName: "zero.runs.queue",
});

export { handler as GET };
