import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { zeroRunAgentEventsContract } from "@vm0/core/contracts/zero-runs";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import { getRunAgentEvents } from "../../../../../../../src/lib/infra/run/run-telemetry-service";
import { isNotFound } from "../../../../../../../src/lib/shared/errors";

const router = tsr.router(zeroRunAgentEventsContract, {
  getAgentEvents: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const result = await getRunAgentEvents(
        params.id,
        userId,
        org.orgId,
        query,
      );
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroRunAgentEventsContract, router, {
  routeName: "zero.runs.telemetry.agent",
});

export { handler as GET };
