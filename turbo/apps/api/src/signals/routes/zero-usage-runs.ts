import { command } from "ccstate";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { zeroUsageRuns$ } from "../services/zero-usage.service";

function forbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only org admins can view run usage",
        code: "FORBIDDEN",
      },
    },
  };
}

function parseUserIds(value: string | undefined): string[] | undefined {
  return value
    ? value
        .split(",")
        .map((item) => {
          return item.trim();
        })
        .filter(Boolean)
    : undefined;
}

const getUsageRunsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return forbidden();
    }

    const query = get(queryOf(zeroUsageRunsContract.get));
    const body = await set(
      zeroUsageRuns$,
      {
        orgId: auth.orgId,
        page: query.page,
        pageSize: query.pageSize,
        runId: query.runId,
        agentId: query.agentId,
        userIds: parseUserIds(query.userIds),
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const zeroUsageRunsRoutes: readonly RouteEntry[] = [
  {
    route: zeroUsageRunsContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageRunsInner$,
    ),
  },
];
