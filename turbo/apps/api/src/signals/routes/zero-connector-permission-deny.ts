import { zeroConnectorPermissionDenyContract } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { resolveConnectorPermissionDeny$ } from "../services/connector-permission-deny.service";

const diagnoseInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(zeroConnectorPermissionDenyContract.diagnose),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const params = get(
    pathParamsOf(zeroConnectorPermissionDenyContract.diagnose),
  );
  const result = await set(
    resolveConnectorPermissionDeny$,
    {
      connectorRef: params.connectorRef,
      method: bodyResult.data.method,
      url: bodyResult.data.url,
      orgId: auth.orgId,
      userId: auth.userId,
      stateSource:
        auth.tokenType === "zero"
          ? { kind: "run", runId: auth.runId }
          : { kind: "stored" },
    },
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: result };
});

export const zeroConnectorPermissionDenyRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorPermissionDenyContract.diagnose,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      diagnoseInner$,
    ),
  },
];
