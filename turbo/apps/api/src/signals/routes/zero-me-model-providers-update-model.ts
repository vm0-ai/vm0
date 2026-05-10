import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { zeroPersonalModelProvidersUpdateModelContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { isNotFoundResponse, notFound } from "../../lib/error";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { updateUserModelProviderModel$ } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const updateModelInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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
    return notFound("Not found");
  }

  const params = get(
    pathParamsOf(zeroPersonalModelProvidersUpdateModelContract.updateModel),
  );
  signal.throwIfAborted();
  const bodyResult = await get(
    bodyResultOf(zeroPersonalModelProvidersUpdateModelContract.updateModel),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateUserModelProviderModel$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      type: params.type,
      selectedModel: bodyResult.data.selectedModel,
    },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  return result;
});

export const zeroMeModelProvidersUpdateModelRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersUpdateModelContract.updateModel,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelInner$,
    ),
  },
];
