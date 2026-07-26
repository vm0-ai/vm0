import { computed } from "ccstate";
import {
  runsByIdContract,
  runsMainContract,
} from "@vm0/api-contracts/contracts/runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { agentRunList, zeroRunById } from "../services/zero-runs.service";
import type { RouteEntry } from "../route-entry";

const agentRunReadAuth = {
  acceptAnySandboxCapability: true,
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const runNotFound = notFound("Agent run not found");

const listRunsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(runsMainContract.list));
  const result = await get(
    agentRunList({
      userId: auth.userId,
      orgId: auth.orgId,
      status: query.status,
      agent: query.agent,
      since: query.since,
      until: query.until,
      limit: query.limit,
    }),
  );

  if (result.kind === "bad-request") {
    return badRequestMessage(result.message);
  }

  return { status: 200 as const, body: result.body };
});

const getRunByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runsByIdContract.getById));
  const run = await get(
    zeroRunById({ runId: params.id, userId: auth.userId, orgId: auth.orgId }),
  );
  if (!run) {
    return runNotFound;
  }
  return { status: 200 as const, body: run };
});

export const agentRunsReadRoutes: readonly RouteEntry[] = [
  {
    route: runsMainContract.list,
    handler: authRoute(agentRunReadAuth, listRunsInner$),
  },
  {
    route: runsByIdContract.getById,
    handler: authRoute(agentRunReadAuth, getRunByIdInner$),
  },
];
