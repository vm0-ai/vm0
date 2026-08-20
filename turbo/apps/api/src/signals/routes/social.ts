import { socialContract } from "@okouai/api-contracts/contracts/social";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { socialKitRequest$ } from "../services/social.service";

const socialKitRequestBody$ = bodyResultOf(socialContract.request);

const socialKitDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Managed SocialKit is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const socialKitEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.ManagedSocialKit, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const socialKitRequestInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(socialKitRequestBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (!(await set(socialKitEnabled$))) {
      return socialKitDisabled;
    }
    signal.throwIfAborted();
    return await set(
      socialKitRequest$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

export const socialRoutes: readonly RouteEntry[] = [
  {
    route: socialContract.request,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "social:read",
      },
      socialKitRequestInner$,
    ),
  },
];
