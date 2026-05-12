import { computed } from "ccstate";
import { permissionAccessRequestsListContract } from "@vm0/api-contracts/contracts/zero-agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { listPermissionAccessRequests } from "../services/zero-permission-access-requests.service";
import type { RouteEntry } from "../route";

const missingLookupQuery = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Either agentId or requestId is required",
      code: "VALIDATION_ERROR" as const,
    }),
  }),
});

const listQuery$ = queryOf(permissionAccessRequestsListContract.list);

const listPermissionAccessRequestsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(listQuery$);

  if (!query.agentId && !query.requestId) {
    return missingLookupQuery;
  }

  const requests = await get(
    listPermissionAccessRequests({
      orgId: auth.orgId,
      userId: auth.userId,
      orgRole: auth.orgRole,
      agentId: query.agentId,
      requestId: query.requestId,
      status: query.status,
    }),
  );

  return { status: 200 as const, body: [...requests] };
});

export const zeroPermissionAccessRequestsRoutes: readonly RouteEntry[] = [
  {
    route: permissionAccessRequestsListContract.list,
    handler: authRoute(
      {
        requiredCapability: "agent:read",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      listPermissionAccessRequestsInner$,
    ),
  },
];
