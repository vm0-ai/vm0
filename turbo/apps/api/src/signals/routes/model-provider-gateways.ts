import { command, computed } from "ccstate";
import {
  modelProviderConnectionsByIdContract,
  modelProviderConnectionsMainContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";

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
} from "../services/model-provider-gateway.service";

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
      bodyResultOf(modelProviderConnectionsMainContract.create),
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
      get(bodyResultOf(modelProviderConnectionsByIdContract.update)),
      get(pathParamsOf(modelProviderConnectionsByIdContract.update)),
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
      pathParamsOf(modelProviderConnectionsByIdContract.delete),
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

export const modelProviderGatewayRoutes: readonly RouteEntry[] = [
  {
    route: modelProviderConnectionsMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listConnectionsInner$,
    ),
  },
  {
    route: modelProviderConnectionsMainContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createConnectionInner$,
    ),
  },
  {
    route: modelProviderConnectionsByIdContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateConnectionInner$,
    ),
  },
  {
    route: modelProviderConnectionsByIdContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteConnectionInner$,
    ),
  },
];
