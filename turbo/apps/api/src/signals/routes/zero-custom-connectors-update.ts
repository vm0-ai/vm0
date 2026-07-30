import { command } from "ccstate";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  getCustomConnectorResponse,
  updateCustomConnectorDefinition$,
} from "../services/zero-custom-connector.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.update));
  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorByIdContract.update),
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
    !isFeatureEnabled(FeatureSwitchKey.CustomConnectorOAuth2, featureContext)
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Custom connector editing is not enabled",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }
  if (
    (bodyResult.data.permissionBundleRef !== undefined ||
      bodyResult.data.skillMarkdown !== undefined) &&
    !isFeatureEnabled(
      FeatureSwitchKey.CustomConnectorPermissionsAndSkills,
      featureContext,
    )
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          message: "Custom connector permissions and skills are not enabled",
          code: "FORBIDDEN" as const,
        },
      },
    };
  }

  const result = await set(
    updateCustomConnectorDefinition$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      id: params.id,
      input: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }

  const connector = await get(
    getCustomConnectorResponse({
      orgId: auth.orgId,
      userId: auth.userId,
      connectorId: result.id,
    }),
  );
  signal.throwIfAborted();
  if (!connector) {
    return notFound("Custom connector not found");
  }
  return { status: 200 as const, body: connector };
});

export const zeroCustomConnectorsUpdateRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorByIdContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateInner$,
    ),
  },
];
