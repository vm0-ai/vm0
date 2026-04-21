import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroUsageInsightContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getUsageInsight } from "../../../../../src/lib/zero/billing/usage-insight-service";

const router = tsr.router(zeroUsageInsightContract, {
  get: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    // Validate timezone — Intl.DateTimeFormat constructor is the only standard
    // API that synchronously throws on an unrecognised IANA timezone string.
    try {
      Intl.DateTimeFormat(undefined, { timeZone: query.tz });
    } catch {
      return createErrorResponse(
        "BAD_REQUEST",
        `Invalid timezone: ${query.tz}`,
      );
    }

    const result = await getUsageInsight(authCtx.userId, org.orgId, {
      range: query.range,
      groupBy: query.groupBy,
      tz: query.tz,
    });

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroUsageInsightContract, router, {
  routeName: "zero.usage.insight",
});

export { handler as GET };
