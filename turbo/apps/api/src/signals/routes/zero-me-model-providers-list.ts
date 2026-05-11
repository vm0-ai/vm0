import { computed } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { zeroUserModelProviders } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const featureDisabled = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({ message: "Not found", code: "NOT_FOUND" }),
  }),
});

function isModelFirstPersonalProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function isModelFirstPersonalProviderApiEnabled(
  params: Parameters<typeof isFeatureEnabled>[1],
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.ModelFirstModelProvider, params);
}

function visibleModelFirstProviders(
  result: ModelProviderListResponse,
): ModelProviderListResponse {
  return {
    modelProviders: result.modelProviders.filter((provider) => {
      return isModelFirstPersonalProviderType(provider.type);
    }),
  };
}

const listInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );

  if (
    !isModelFirstPersonalProviderApiEnabled({
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return featureDisabled;
  }

  const result = await get(zeroUserModelProviders(auth.orgId, auth.userId));
  return { status: 200 as const, body: visibleModelFirstProviders(result) };
});

export const zeroMeModelProvidersListRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listInner$,
    ),
  },
];
