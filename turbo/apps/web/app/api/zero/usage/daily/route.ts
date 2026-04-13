import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroUsageDailyContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getDailyCredits } from "../../../../../src/lib/zero/billing/usage-service";

const router = tsr.router(zeroUsageDailyContract, {
  get: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can view daily usage",
      );
    }

    const response = await getDailyCredits(org.orgId, {
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      mode: query.mode,
    });

    return { status: 200 as const, body: response };
  },
});

const handler = createHandler(zeroUsageDailyContract, router, {
  errorHandler: createSafeErrorHandler("zero-usage-daily"),
});

export { handler as GET };
