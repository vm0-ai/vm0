import { command, type Computed } from "ccstate";
import { zeroWebsiteIoGenerateContract } from "@vm0/api-contracts/contracts/zero-website-io-generate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  checkWebsiteCredits$,
  generateWebsite$,
  parseWebsiteOptions,
  websiteInsufficientCredits,
  websitePricing$,
  websiteServiceUnavailable,
} from "../services/zero-website-io-generate.service";

const hostedSitesDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Hosted sites are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const websiteBody$ = bodyResultOf(zeroWebsiteIoGenerateContract.post);

async function hostedSitesEnabled(
  get: <T>(computed: Computed<T>) => T,
  auth: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.HostedSites, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
}

const postWebsiteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await hostedSitesEnabled(get, auth);
  signal.throwIfAborted();
  if (!enabled) {
    return hostedSitesDisabled;
  }

  const bodyResult = await get(websiteBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const options = parseWebsiteOptions(bodyResult.data);
  if ("status" in options) {
    return options;
  }

  const hasCredits = await set(
    checkWebsiteCredits$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (!hasCredits) {
    return websiteInsufficientCredits();
  }

  const pricing = await get(websitePricing$);
  signal.throwIfAborted();
  if (!pricing) {
    return websiteServiceUnavailable(
      "Website generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const result = await set(
    generateWebsite$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      options,
      pricing,
    },
    signal,
  );
  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

export const zeroWebsiteIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: zeroWebsiteIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "host:write",
      },
      postWebsiteInner$,
    ),
  },
];
