import { command, computed } from "ccstate";
import {
  permissionAccessRequestsCreateContract,
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  createPermissionAccessRequest$,
  listPermissionAccessRequests,
  resolvePermissionAccessRequest$,
} from "../services/zero-permission-access-requests.service";
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
const createBody$ = bodyResultOf(permissionAccessRequestsCreateContract.create);
const resolveBody$ = bodyResultOf(
  permissionAccessRequestsResolveContract.resolve,
);

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

const createPermissionAccessRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(createBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      createPermissionAccessRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        request: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 201 as const, body: result.request };
    }
    return result;
  },
);

const resolvePermissionAccessRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(resolveBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      resolvePermissionAccessRequest$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        role: auth.orgRole ?? "member",
        requestId: bodyResult.data.requestId,
        action: bodyResult.data.action,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: result.request };
    }
    return result;
  },
);

export const zeroPermissionAccessRequestsRoutes: readonly RouteEntry[] = [
  {
    route: permissionAccessRequestsCreateContract.create,
    handler: authRoute(
      {
        requiredCapability: "agent:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createPermissionAccessRequestInner$,
    ),
  },
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
  {
    route: permissionAccessRequestsResolveContract.resolve,
    handler: authRoute(
      {
        requiredCapability: "agent:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      resolvePermissionAccessRequestInner$,
    ),
  },
];
