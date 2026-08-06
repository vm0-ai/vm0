import { command, computed } from "ccstate";
import {
  zeroModelProviderConnectionsByIdContract,
  zeroModelProviderConnectionsMainContract,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";

import { badRequestMessage, isNotFoundResponse } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createModelProviderConnection$,
  deleteModelProviderConnection$,
  modelProviderConnectionsForOrg,
  updateModelProviderConnection$,
} from "../services/zero-model-provider-gateway.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage custom model providers",
      code: "FORBIDDEN",
    }),
  }),
});

function isErrorResponse(
  value: unknown,
): value is ReturnType<typeof badRequestMessage> {
  return typeof value === "object" && value !== null && "status" in value;
}

const listConnectionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  return {
    status: 200 as const,
    body: await get(modelProviderConnectionsForOrg(auth.orgId)),
  };
});

const createConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const body = await get(
      bodyResultOf(zeroModelProviderConnectionsMainContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      createModelProviderConnection$,
      { orgId: auth.orgId, userId: auth.userId, input: body.data },
      signal,
    );
    return isErrorResponse(result)
      ? result
      : { status: 201 as const, body: result };
  },
);

const updateConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const [body, params] = await Promise.all([
      get(bodyResultOf(zeroModelProviderConnectionsByIdContract.update)),
      get(pathParamsOf(zeroModelProviderConnectionsByIdContract.update)),
    ]);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      updateModelProviderConnection$,
      {
        orgId: auth.orgId,
        connectionId: params.id,
        input: body.data,
      },
      signal,
    );
    return isErrorResponse(result)
      ? result
      : { status: 200 as const, body: result };
  },
);

const deleteConnectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const params = await get(
      pathParamsOf(zeroModelProviderConnectionsByIdContract.delete),
    );
    signal.throwIfAborted();
    const result = await set(
      deleteModelProviderConnection$,
      { orgId: auth.orgId, connectionId: params.id },
      signal,
    );
    return isNotFoundResponse(result)
      ? result
      : { status: 204 as const, body: undefined };
  },
);

export const zeroModelProviderGatewayRoutes: readonly RouteEntry[] = [
  {
    route: zeroModelProviderConnectionsMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listConnectionsInner$,
    ),
  },
  {
    route: zeroModelProviderConnectionsMainContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createConnectionInner$,
    ),
  },
  {
    route: zeroModelProviderConnectionsByIdContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateConnectionInner$,
    ),
  },
  {
    route: zeroModelProviderConnectionsByIdContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteConnectionInner$,
    ),
  },
];
