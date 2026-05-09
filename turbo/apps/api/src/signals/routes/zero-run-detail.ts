import { computed } from "ccstate";
import {
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
} from "@vm0/api-contracts/contracts/zero-runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import {
  zeroRunAgentEvents,
  zeroRunContext,
  zeroRunNetworkLogs,
} from "../services/zero-run-detail.service";
import type { RouteEntry } from "../route";

const runReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent-run:read",
} as const;

const runNotFound = notFound("Agent run not found");

const getContextInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroRunContextContract.getContext));
  const result = await get(zeroRunContext(params.id, auth.userId, auth.orgId));
  if (result.kind === "not-found") {
    return runNotFound;
  }
  if (result.kind === "no-snapshot") {
    return notFound("Run context not available");
  }
  return { status: 200 as const, body: result.context };
});

const getNetworkLogsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroRunNetworkLogsContract.getNetworkLogs));
  const query = get(queryOf(zeroRunNetworkLogsContract.getNetworkLogs));
  const result = await get(
    zeroRunNetworkLogs({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return runNotFound;
  }
  return { status: 200 as const, body: result };
});

const getAgentEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroRunAgentEventsContract.getAgentEvents));
  const query = get(queryOf(zeroRunAgentEventsContract.getAgentEvents));
  const result = await get(
    zeroRunAgentEvents({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return runNotFound;
  }
  return { status: 200 as const, body: result };
});

export const zeroRunDetailRoutes: readonly RouteEntry[] = [
  {
    route: zeroRunContextContract.getContext,
    handler: authRoute(runReadAuth, getContextInner$),
  },
  {
    route: zeroRunNetworkLogsContract.getNetworkLogs,
    handler: authRoute(runReadAuth, getNetworkLogsInner$),
  },
  {
    route: zeroRunAgentEventsContract.getAgentEvents,
    handler: shadowCompareRoute({
      route: zeroRunAgentEventsContract.getAgentEvents,
      handler: authRoute(runReadAuth, getAgentEventsInner$),
    }),
  },
];
