import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunsCancelContract, createErrorResponse } from "@vm0/core";
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
import { processOrgCredits } from "../../../../../../src/lib/zero/credit/credit-service";
import {
  isNotFound,
  isBadRequest,
} from "../../../../../../src/lib/shared/errors";
import { after } from "next/server";

const router = tsr.router(zeroRunsCancelContract, {
  cancel: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const result = await cancelRun(params.id, userId, org.orgId);

      after(async () => {
        const shouldProcessCredits = await dispatchCancelSideEffects(
          result,
          (orgId) => {
            return drainOrgQueue(orgId, dispatchQueuedZeroRun);
          },
        );
        if (shouldProcessCredits) {
          await processOrgCredits(result.orgId);
        }
      });

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
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroRunsCancelContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:cancel"),
});

export { handler as POST };
