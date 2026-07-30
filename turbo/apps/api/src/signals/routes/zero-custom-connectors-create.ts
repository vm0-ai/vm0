import { command } from "ccstate";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createCustomConnector$,
  serialiseCustomConnector,
} from "../services/zero-custom-connector.service";
import { isBadRequestResponse } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can create custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

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
  if (bodyResult.data.authMode === "oauth") {
    const featureContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.CustomConnectorOAuth2, featureContext)
    ) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Custom connector OAuth 2.0 is not enabled",
            code: "FORBIDDEN" as const,
          },
        },
      };
    }
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

  return {
    status: 201 as const,
    body: serialiseCustomConnector({ row: result, valueMarkers: [] }),
  };
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
