import { command } from "ccstate";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setCustomConnectorValues$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

const setSecretInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorSecretContract.set));
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorSecretContract.set),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    setCustomConnectorValues$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
      values: [{ key: "secret", kind: "secret", value: bodyResult.data.value }],
      syncLegacySecret: true,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }

  return { status: 204 as const, body: undefined };
});

export const zeroCustomConnectorsSecretSetRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorSecretContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setSecretInner$,
    ),
  },
];
