import { computed } from "ccstate";
import {
  runAgentEventsContract,
  runEventsContract,
  runMetricsContract,
  runNetworkLogsContract,
  runSystemLogContract,
  runTelemetryContract,
} from "@vm0/api-contracts/contracts/runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  agentRunAgentEvents,
  agentRunEvents,
  agentRunMetrics,
  agentRunNetworkLogs,
  agentRunSystemLog,
  agentRunTelemetry,
} from "../services/agent-run-telemetry.service";
import type { RouteEntry } from "../route";

const anySandboxOrgAuth = {
  acceptAnySandboxCapability: true,
  requireOrganization: true,
} as const;

const agentRunNotFound = notFound("Agent run not found");

const getEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runEventsContract.getEvents));
  const query = get(queryOf(runEventsContract.getEvents));
  const result = await get(
    agentRunEvents({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

const getTelemetryInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runTelemetryContract.getTelemetry));
  const result = await get(
    agentRunTelemetry({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

const getAgentEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runAgentEventsContract.getAgentEvents));
  const query = get(queryOf(runAgentEventsContract.getAgentEvents));
  const result = await get(
    agentRunAgentEvents({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

const getSystemLogInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runSystemLogContract.getSystemLog));
  const query = get(queryOf(runSystemLogContract.getSystemLog));
  const result = await get(
    agentRunSystemLog({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

const getMetricsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runMetricsContract.getMetrics));
  const query = get(queryOf(runMetricsContract.getMetrics));
  const result = await get(
    agentRunMetrics({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

const getNetworkLogsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runNetworkLogsContract.getNetworkLogs));
  const query = get(queryOf(runNetworkLogsContract.getNetworkLogs));
  const result = await get(
    agentRunNetworkLogs({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return agentRunNotFound;
  }
  return { status: 200 as const, body: result };
});

export const agentRunTelemetryRoutes: readonly RouteEntry[] = [
  {
    route: runEventsContract.getEvents,
    handler: authRoute(anySandboxOrgAuth, getEventsInner$),
  },
  {
    route: runAgentEventsContract.getAgentEvents,
    handler: authRoute(anySandboxOrgAuth, getAgentEventsInner$),
  },
  {
    route: runSystemLogContract.getSystemLog,
    handler: authRoute(anySandboxOrgAuth, getSystemLogInner$),
  },
  {
    route: runMetricsContract.getMetrics,
    handler: authRoute(anySandboxOrgAuth, getMetricsInner$),
  },
  {
    route: runNetworkLogsContract.getNetworkLogs,
    handler: authRoute(anySandboxOrgAuth, getNetworkLogsInner$),
  },
  {
    route: runTelemetryContract.getTelemetry,
    handler: authRoute(anySandboxOrgAuth, getTelemetryInner$),
  },
];
