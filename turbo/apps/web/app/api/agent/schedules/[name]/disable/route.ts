import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { schedulesDisableContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { disableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const log = logger("api:schedules:disable");

const router = tsr.router(schedulesDisableContract, {
  disable: async ({ params, query, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const {
      org: { orgId },
    } = await resolveOrg(authCtx, query.org);

    log.debug(
      `Disabling schedule ${params.name} for compose ${body.composeId}`,
    );

    try {
      const schedule = await disableSchedule(
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
      throw error;
    }
  },
});

const handler = createHandler(schedulesDisableContract, router, {
  errorHandler: createSafeErrorHandler("schedules:disable"),
});

export { handler as POST };
