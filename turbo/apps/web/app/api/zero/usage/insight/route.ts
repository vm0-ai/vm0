import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getUsageInsight } from "../../../../../src/lib/zero/billing/usage-insight-service";
import { isBadRequest } from "@vm0/api-services/errors";

const router = tsr.router(zeroUsageInsightContract, {
  get: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("UNAUTHORIZED", "Not authenticated");
      }
      throw error;
    }

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

    if (query.range === "day") {
      if (!query.date || !/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
        return createErrorResponse(
          "BAD_REQUEST",
          "date must be YYYY-MM-DD when range=day",
        );
      }
    }

    const result = await getUsageInsight(authCtx.userId, orgId, {
      range: query.range,
      date: query.date,
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
