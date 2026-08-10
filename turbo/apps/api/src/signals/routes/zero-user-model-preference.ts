import { command, computed } from "ccstate";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { UserPreferenceChangedPayload } from "@vm0/api-contracts/contracts/realtime";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";

import { badRequestMessage } from "../../lib/error";
import { publishUserPreferenceChangedForUserSafely } from "../external/realtime";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { isCodexFastServiceTierSupported } from "../services/zero-model-selection.service";
import { listOrgModelPolicies$ } from "../services/zero-model-policy.service";
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

    const policies =
      body.data.selectedModel === null
        ? null
        : await set(
            listOrgModelPolicies$,
            { orgId: auth.orgId, userId: auth.userId },
            signal,
          );
    signal.throwIfAborted();
    const selectedPolicy = policies?.policies.find((policy) => {
      return policy.model === body.data.selectedModel;
    });
    if (body.data.selectedModel !== null && !selectedPolicy) {
      return badRequestMessage("Invalid request");
    }

    if (body.data.codexServiceTier === "fast") {
      const featureSwitchContext = await loadUserFeatureSwitchContext(
        set(writeDb$),
        auth.orgId,
        auth.userId,
      );
      signal.throwIfAborted();
      const codexFastModeEnabled = isFeatureEnabled(
        FeatureSwitchKey.CodexFastMode,
        featureSwitchContext,
      );
      if (!codexFastModeEnabled) {
        return badRequestMessage(
          "Codex fast mode is not enabled for this workspace",
        );
      }
      if (
        selectedPolicy?.routeStatus !== "valid" ||
        !isCodexFastServiceTierSupported({
          selectedModel: body.data.selectedModel,
          effectiveModelProvider: selectedPolicy?.defaultProviderType,
          codexFastModeEnabled,
        })
      ) {
        return badRequestMessage(
          "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 and GPT 5.6 runs",
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
