import { command } from "ccstate";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  listUserPermissionGrants$,
  resetUserPermissionGrants$,
  upsertUserPermissionGrant$,
} from "../services/zero-user-permission-grants.service";

const userPermissionGrantAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const listQuery$ = queryOf(zeroUserPermissionGrantsContract.list);
const upsertBody$ = bodyResultOf(zeroUserPermissionGrantsContract.upsert);
const resetQuery$ = queryOf(zeroUserPermissionGrantsContract.reset);

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

const upsertUserPermissionGrantInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(upsertBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      upsertUserPermissionGrant$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        grant: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 200 as const, body: result.grant };
    }
    return result;
  },
);

const resetUserPermissionGrantsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(resetQuery$);
    const result = await set(
      resetUserPermissionGrants$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        reset: query,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("kind" in result) {
      return { status: 204 as const, body: undefined };
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
    route: zeroUserPermissionGrantsContract.upsert,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      upsertUserPermissionGrantInner$,
    ),
  },
  {
    route: zeroUserPermissionGrantsContract.reset,
    handler: authRoute(
      userPermissionGrantAuthOptions,
      resetUserPermissionGrantsInner$,
    ),
  },
];
