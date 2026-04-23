import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroUsageRunsContract } from "@vm0/core/contracts/zero-usage-daily";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getUsageRuns } from "../../../../../src/lib/zero/billing/usage-service";

const router = tsr.router(zeroUsageRunsContract, {
  get: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can view run usage",
      );
    }

    const userIds = query.userIds
      ? query.userIds
          .split(",")
          .map((s) => {
            return s.trim();
          })
          .filter(Boolean)
      : undefined;

    const response = await getUsageRuns(org.orgId, {
      page: query.page,
      pageSize: query.pageSize,
      agentId: query.agentId,
      userIds,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });

    return { status: 200 as const, body: response };
  },
});

const handler = createHandler(zeroUsageRunsContract, router, {
  routeName: "zero.usage.runs",
});

export { handler as GET };
