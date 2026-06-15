import { computed } from "ccstate";
import { logsSearchContract } from "@vm0/api-contracts/contracts/runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { zeroLogSearch } from "../services/zero-logs.service";

const searchLogsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(logsSearchContract.searchLogs));
  const body = await get(
    zeroLogSearch({
      userId: auth.userId,
      orgId: auth.orgId,
      keyword: query.keyword,
      agentId: query.agentId,
      runId: query.runId,
      since: query.since,
      limit: query.limit,
      before: query.before,
      after: query.after,
    }),
  );

  return { status: 200 as const, body };
});

export const logsSearchRoutes: readonly RouteEntry[] = [
  {
    route: logsSearchContract.searchLogs,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      searchLogsInner$,
    ),
  },
];
