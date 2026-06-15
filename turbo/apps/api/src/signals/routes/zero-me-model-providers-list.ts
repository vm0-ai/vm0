import { computed } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroUserModelProviders } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

function isModelFirstPersonalProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
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
