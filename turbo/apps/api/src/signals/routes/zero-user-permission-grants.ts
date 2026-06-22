import { command } from "ccstate";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  applyUserPermissionGrants$,
  listUserPermissionGrants$,
} from "../services/zero-user-permission-grants.service";

const userPermissionGrantAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const listQuery$ = queryOf(zeroUserPermissionGrantsContract.list);
const applyBody$ = bodyResultOf(zeroUserPermissionGrantsContract.apply);

const listUserPermissionGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(listQuery$);
    const result = await set(
      listUserPermissionGrants$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: query.agentId,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: [...result.grants] };
    }
    return result;
  },
);

const applyUserPermissionGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(applyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      applyUserPermissionGrants$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        apply: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: [...result.grants] };
    }
    return result;
  },
);

export const zeroUserPermissionGrantsRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserPermissionGrantsContract.list,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      listUserPermissionGrantsInner$,
    ),
  },
  {
    route: zeroUserPermissionGrantsContract.apply,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      applyUserPermissionGrantsInner$,
    ),
  },
];
