import { command } from "ccstate";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  checkImageCredits$,
  generateImageWithProvider,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  parseImageOptions,
  recordGeneratedImage$,
  serviceUnavailable,
} from "../services/zero-image-io-generate.service";

const imageBody$ = bodyResultOf(zeroImageIoGenerateContract.post);

const postImageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(imageBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const options = parseImageOptions(bodyResult.data);
  if ("status" in options) {
    return options;
  }

  const hasCredits = await set(
    checkImageCredits$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (!hasCredits) {
    return insufficientCredits();
  }

  const pricing = await get(imagePricing$);
  signal.throwIfAborted();
  const missingPricing = getMissingImagePricing(pricing, options.model);
  if (missingPricing.length > 0) {
    return serviceUnavailable(
      "Image generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const generation = await generateImageWithProvider(options, signal);
  signal.throwIfAborted();
  if ("status" in generation) {
    return generation;
  }

  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const result = await set(
    recordGeneratedImage$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      pricing,
      generation,
    },
    signal,
  );

  return { status: 200 as const, body: result };
});

export const zeroImageIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: zeroImageIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postImageInner$,
    ),
  },
];
