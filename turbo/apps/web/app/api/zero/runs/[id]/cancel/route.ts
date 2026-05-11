import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunsCancelContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { cancelRun } from "../../../../../../src/lib/zero/zero-run-cancel";
import { dispatchCancelSideEffects } from "../../../../../../src/lib/infra/run/run-service";
import {
  dispatchQueuedZeroRun,
  drainOrgQueue,
} from "../../../../../../src/lib/zero/zero-run-queue-service";
import { processOrgUsageEvents } from "../../../../../../src/lib/zero/credit/usage-event-service";
import { logger } from "../../../../../../src/lib/shared/logger";
import {
  isNotFound,
  isBadRequest,
  isRunNotCancellable,
} from "@vm0/api-services/errors";

const log = logger("api:zero-runs:cancel");

const router = tsr.router(zeroRunsCancelContract, {
  cancel: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const result = await cancelRun(params.id, userId, org.orgId);

      if (!result.alreadyCancelled) {
        try {
          const shouldProcessCredits = await dispatchCancelSideEffects(
            result,
            (orgId) => {
              return drainOrgQueue(orgId, dispatchQueuedZeroRun);
            },
          );
          if (shouldProcessCredits) {
            await processOrgUsageEvents(result.orgId);
          }
        } catch (sideEffectError) {
          log.error("Failed to dispatch run cancel side effects", {
            runId: result.runId,
            sideEffectError,
          });
        }
      }

      return {
        status: 200 as const,
        body: {
          id: result.runId,
          status: "cancelled" as const,
          message: "Run cancelled successfully",
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", error.message);
      }
      if (isRunNotCancellable(error)) {
        return createErrorResponse("RUN_NOT_CANCELLABLE", error.message);
      }
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroRunsCancelContract, router, {
  routeName: "zero.runs.cancel",
});

export { handler as POST };
