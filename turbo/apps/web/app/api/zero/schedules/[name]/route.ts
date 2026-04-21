import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroSchedulesByNameContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { deleteSchedule } from "../../../../../src/lib/zero/schedule";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroSchedulesByNameContract, {
  delete: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "schedule:delete",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    try {
      const {
        org: { orgId },
      } = await resolveOrg(authCtx);

      await deleteSchedule(userId, orgId, query.agentId, params.name);

      return {
        status: 204 as const,
        body: undefined,
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

const handler = createHandler(zeroSchedulesByNameContract, router, {
  routeName: "zero.schedules.byName",
});

export { handler as DELETE };
