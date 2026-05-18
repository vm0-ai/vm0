import { command } from "ccstate";
import { zeroWebsiteIoGenerateContract } from "@vm0/api-contracts/contracts/zero-website-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  checkWebsiteCredits$,
  generateWebsite$,
  parseWebsiteOptions,
  websiteInsufficientCredits,
  websitePricing$,
  websiteServiceUnavailable,
} from "../services/zero-website-io-generate.service";

const websiteBody$ = bodyResultOf(zeroWebsiteIoGenerateContract.post);

const postWebsiteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
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
