import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { schedulesEnableContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { enableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound, isSchedulePast } from "../../../../../../src/lib/errors";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const log = logger("api:schedules:enable");

const router = tsr.router(schedulesEnableContract, {
  enable: async ({ params, query, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const {
      org: { orgId },
    } = await resolveOrg(authCtx, query.org);

    log.debug(`Enabling schedule ${params.name} for compose ${body.composeId}`);

    try {
      const schedule = await enableSchedule(
        userId,
        orgId,
        body.composeId,
        params.name,
      );

      return {
        status: 200 as const,
        body: schedule,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Resource not found", code: "NOT_FOUND" },
          },
        };
      }
      if (isSchedulePast(error)) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Schedule time has already passed",
              code: "SCHEDULE_PAST",
            },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(schedulesEnableContract, router, {
  errorHandler: createSafeErrorHandler("schedules:enable"),
});

export { handler as POST };
