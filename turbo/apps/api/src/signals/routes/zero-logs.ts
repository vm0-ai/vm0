import { computed } from "ccstate";
import {
  logsByIdContract,
  logsListContract,
} from "@vm0/api-contracts/contracts/logs";
import { zeroLogsSearchContract } from "@vm0/api-contracts/contracts/zero-runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import {
  zeroLogDetail,
  zeroLogsList,
  zeroLogSearch,
} from "../services/zero-logs.service";
import type { RouteEntry } from "../route";

const runReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent-run:read",
} as const;

const logNotFound = notFound("Log not found");

const getLogsListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(logsListContract.list));
  const result = await get(
    zeroLogsList({
      userId: auth.userId,
      orgId: auth.orgId,
      cursor: query.cursor,
      limit: query.limit,
      search: query.search,
      agentId: query.agentId,
      name: query.name,
      since: query.since,
      status: query.status,
      triggerSource: query.triggerSource,
      scheduleId: query.scheduleId,
    }),
  );
  return { status: 200 as const, body: result };
});

const getLogByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(logsByIdContract.getById));
  const detail = await get(
    zeroLogDetail({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!detail) {
    return logNotFound;
  }
  return { status: 200 as const, body: detail };
});

const searchLogsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroLogsSearchContract.searchLogs));
  const result = await get(
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
  return { status: 200 as const, body: result };
});

export const zeroLogsRoutes: readonly RouteEntry[] = [
  {
    route: logsListContract.list,
    handler: authRoute(runReadAuth, getLogsListInner$),
  },
  {
    route: logsByIdContract.getById,
    handler: authRoute(runReadAuth, getLogByIdInner$),
  },
  {
    route: zeroLogsSearchContract.searchLogs,
    handler: shadowCompareRoute({
      route: zeroLogsSearchContract.searchLogs,
      handler: authRoute(runReadAuth, searchLogsInner$),
    }),
  },
];
