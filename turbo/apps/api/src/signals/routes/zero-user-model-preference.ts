import { command, computed } from "ccstate";
import type { UserPreferenceChangedPayload } from "@vm0/api-contracts/contracts/realtime";
import { getRetiredRunModelReplacement } from "@vm0/api-contracts/contracts/model-providers";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { badRequestMessage, modelRetired } from "../../lib/error";
import { publishUserPreferenceChangedForUserSafely } from "../external/realtime";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { listOrgModelPolicies$ } from "../services/zero-model-policy.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { isCodexFastServiceTierSupported } from "../services/zero-model-selection.service";
import { writeDb$ } from "../external/db";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/zero-user-data.service";

const updateBody$ = bodyResultOf(zeroUserModelPreferenceContract.update);

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

    if (body.data.selectedModel !== null) {
      const capabilities = await loadOrgPlanCapabilities(
        set(writeDb$),
        auth.orgId,
      );
      signal.throwIfAborted();
      const replacement = getRetiredRunModelReplacement(
        body.data.selectedModel,
        {
          restrictedVm0Models:
            capabilities?.status === "active" &&
            capabilities.restrictedVm0Models,
        },
      );
      if (replacement) {
        return modelRetired(body.data.selectedModel, replacement);
      }
    }

    const policies =
      body.data.selectedModel !== null
        ? await set(
            listOrgModelPolicies$,
            { orgId: auth.orgId, userId: auth.userId },
            signal,
          )
        : undefined;
    const configuredPolicy = policies?.policies.find((policy) => {
      return policy.model === body.data.selectedModel;
    });
    if (body.data.selectedModel !== null && !configuredPolicy) {
      return badRequestMessage("Invalid request");
    }

    if (body.data.serviceTier === "priority") {
      if (!configuredPolicy || configuredPolicy.routeStatus !== "valid") {
        return badRequestMessage("Invalid request");
      }
      const featureSwitchContext = await get(
        userFeatureSwitchContext(auth.orgId, auth.userId),
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
        !isCodexFastServiceTierSupported({
          selectedModel: configuredPolicy.model,
          codexFastModeEnabled: true,
        })
      ) {
        return badRequestMessage(
          "Codex fast mode is only available for GPT 5.6 runs",
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
    if ("status" in result) {
      return result;
    }
    signal.throwIfAborted();
    await publishUserPreferenceChangedForUserSafely(auth.userId, [
      "defaultModel",
    ] satisfies UserPreferenceChangedPayload["kinds"]);
    signal.throwIfAborted();
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
