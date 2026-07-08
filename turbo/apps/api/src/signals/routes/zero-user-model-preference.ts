import { command, computed } from "ccstate";
import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { listOrgModelPolicies$ } from "../services/zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/zero-user-data.service";

const updateBody$ = bodyResultOf(zeroUserModelPreferenceContract.update);

function codexFastModePreferenceSupported(
  selectedModel: string | null,
  policies: OrgModelPoliciesResponse,
): boolean {
  return (
    selectedModel === "gpt-5.5" &&
    policies.policies.some((policy) => {
      return (
        policy.model === selectedModel &&
        policy.routeStatus === "valid" &&
        policy.defaultProviderType === "codex-oauth-token"
      );
    })
  );
}

const getUserModelPreferenceInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body };
});

const updateUserModelPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const needsPolicyValidation =
      body.data.selectedModel !== null || body.data.codexServiceTier === "fast";
    const policies = needsPolicyValidation
      ? await set(
          listOrgModelPolicies$,
          { orgId: auth.orgId, userId: auth.userId },
          signal,
        )
      : undefined;
    signal.throwIfAborted();

    if (body.data.selectedModel !== null) {
      if (!policies) {
        return badRequestMessage("Invalid request");
      }
      const configured = policies.policies.some((policy) => {
        return policy.model === body.data.selectedModel;
      });
      if (!configured) {
        return badRequestMessage("Invalid request");
      }
    }
    if (body.data.codexServiceTier === "fast") {
      if (!policies) {
        return badRequestMessage("Invalid request");
      }
      const featureSwitchContext = await loadUserFeatureSwitchContext(
        set(writeDb$),
        auth.orgId,
        auth.userId,
      );
      signal.throwIfAborted();
      if (
        !isFeatureEnabled(FeatureSwitchKey.CodexFastMode, featureSwitchContext)
      ) {
        return badRequestMessage(
          "Codex fast mode is not enabled for this workspace",
        );
      }
      if (
        !codexFastModePreferenceSupported(body.data.selectedModel, policies)
      ) {
        return badRequestMessage(
          "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 runs",
        );
      }
    }

    const result = await set(
      updateUserModelPreference$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preference: body.data,
      },
      signal,
    );
    return { status: 200 as const, body: result };
  },
);

export const zeroUserModelPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserModelPreferenceContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserModelPreferenceInner$,
    ),
  },
  {
    route: zeroUserModelPreferenceContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserModelPreferenceInner$,
    ),
  },
];
