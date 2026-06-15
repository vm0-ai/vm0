import { command } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createCustomConnector$,
  type CustomConnectorRow,
} from "../services/zero-custom-connector.service";
import { isBadRequestResponse } from "../../lib/error";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can create custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

function serialiseRow(row: CustomConnectorRow) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    prefixes: [...row.prefixes],
    headerName: row.headerName,
    headerTemplate: row.headerTemplate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasSecret: false,
  };
}

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorsContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    createCustomConnector$,
    { orgId: auth.orgId, userId: auth.userId, input: bodyResult.data },
    signal,
  );
  signal.throwIfAborted();

  if (isBadRequestResponse(result)) {
    return result;
  }

  return { status: 201 as const, body: serialiseRow(result) };
});

export const zeroCustomConnectorsCreateRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorsContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createInner$,
    ),
  },
];
