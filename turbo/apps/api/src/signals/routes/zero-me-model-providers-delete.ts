import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { isNotFoundResponse } from "../../lib/error";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { deleteUserModelProvider$ } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const featureDisabled = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not found",
      code: "NOT_FOUND",
    }),
  }),
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  const personalEnabled = isFeatureEnabled(
    FeatureSwitchKey.PersonalModelProvider,
    { orgId: auth.orgId, userId: auth.userId, overrides },
  );
  if (!personalEnabled) {
    return featureDisabled;
  }

  const params = get(
    pathParamsOf(zeroPersonalModelProvidersByTypeContract.delete),
  );
  signal.throwIfAborted();

  const result = await set(
    deleteUserModelProvider$,
    { orgId: auth.orgId, userId: auth.userId, type: params.type },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  return { status: 204 as const, body: undefined };
});

export const zeroMeModelProvidersDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersByTypeContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
