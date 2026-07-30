import { command } from "ccstate";
import { zeroCustomConnectorValuesContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { setCustomConnectorValues$ } from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route-entry";

const setValuesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroCustomConnectorValuesContract.set));
  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorValuesContract.set),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.CustomConnectorCliCreate, featureContext)
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Custom connector CLI creation is not enabled",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }

  const result = await set(
    setCustomConnectorValues$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: params.id,
      values: bodyResult.data.values,
      syncLegacySecret: true,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

export const zeroCustomConnectorsValuesSetRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorValuesContract.set,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      setValuesInner$,
    ),
  },
];
