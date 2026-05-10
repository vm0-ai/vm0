import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { zeroPersonalModelProvidersDefaultContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { isNotFoundResponse } from "../../lib/error";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  modelProviderResponse,
  setUserModelProviderDefault$,
} from "../services/zero-model-provider.service";
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

const setDefaultInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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
    pathParamsOf(zeroPersonalModelProvidersDefaultContract.setDefault),
  );
  signal.throwIfAborted();

  const result = await set(
    setUserModelProviderDefault$,
    { orgId: auth.orgId, userId: auth.userId, type: params.type },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }

  const body = modelProviderResponse(result);
  if (!body) {
    // Defensive: should not happen because the contract's pathParam is
    // validated up-front. Surface a 500 rather than a malformed 200 body.
    return {
      status: 500 as const,
      body: {
        error: { message: "Internal server error", code: "INTERNAL" },
      },
    };
  }

  return { status: 200 as const, body };
});

export const zeroMeModelProvidersSetDefaultRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersDefaultContract.setDefault,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setDefaultInner$,
    ),
  },
];
