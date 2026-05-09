import { command } from "ccstate";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { zeroUsageInsight$ } from "../services/zero-usage-insight.service";
import type { RouteEntry } from "../route";

const supportedTimeZones = Object.freeze([
  "UTC",
  ...Intl.supportedValuesOf("timeZone"),
]);

const getUsageInsightInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(zeroUsageInsightContract.get));

    if (!supportedTimeZones.includes(query.tz)) {
      return badRequestMessage(`Invalid timezone: ${query.tz}`);
    }

    if (
      query.range === "day" &&
      (!query.date || !/^\d{4}-\d{2}-\d{2}$/.test(query.date))
    ) {
      return badRequestMessage("date must be YYYY-MM-DD when range=day");
    }

    const body = await set(
      zeroUsageInsight$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        options: query,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const zeroUsageInsightRoutes: readonly RouteEntry[] = [
  {
    route: zeroUsageInsightContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageInsightInner$,
    ),
  },
];
