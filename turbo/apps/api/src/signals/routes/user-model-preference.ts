import { command, computed } from "ccstate";
import {
  getRunModelAccess,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import type { UserPreferenceChangedPayload } from "@okouai/api-contracts/contracts/realtime";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";

import { badRequestMessage } from "../../lib/error";
import { publishUserPreferenceChangedForUserSafely } from "../external/realtime";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { listOrgModelPolicies$ } from "../services/model-policy.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { isCodexFastServiceTierSupported } from "../services/model-selection.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/user-data.service";

const updateBody$ = bodyResultOf(userModelPreferenceContract.update);

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

    if (getRunModelAccess(body.data.selectedModel) === "retired") {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
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
      if (!isCodexFastModeEnabled(featureSwitchContext)) {
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
    signal.throwIfAborted();
    const kinds: UserPreferenceChangedPayload["kinds"] = [
      "defaultModel",
      ...("selectedVideoModel" in body.data
        ? (["defaultVideoModel"] as const)
        : []),
      ...("selectedImageModel" in body.data
        ? (["defaultImageModel"] as const)
        : []),
    ];
    await publishUserPreferenceChangedForUserSafely(auth.userId, kinds);
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

export const userModelPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: userModelPreferenceContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserModelPreferenceInner$,
    ),
  },
  {
    route: userModelPreferenceContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserModelPreferenceInner$,
    ),
  },
];
