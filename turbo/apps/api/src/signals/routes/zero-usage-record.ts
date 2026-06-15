import { command } from "ccstate";
import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { zeroUsageRecord$ } from "../services/zero-usage-record.service";
import type { RouteEntry } from "../route";
import { isValidTimeZone } from "../utils";

function teamUsageRecordsUnavailable() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    },
  };
}

const getUsageRecordInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(zeroUsageRecordContract.get));

    if (!isValidTimeZone(query.tz)) {
      return badRequestMessage(`Invalid timezone: ${query.tz}`);
    }

    if (query.scope === "team") {
      return teamUsageRecordsUnavailable();
    }

    const body = await set(
      zeroUsageRecord$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        scope: query.scope,
        range: query.range,
        tz: query.tz,
        page: query.page,
        pageSize: query.pageSize,
        source: query.source,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const zeroUsageRecordRoutes: readonly RouteEntry[] = [
  {
    route: zeroUsageRecordContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageRecordInner$,
    ),
  },
];
