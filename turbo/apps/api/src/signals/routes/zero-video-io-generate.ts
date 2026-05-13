import { command } from "ccstate";
import { zeroVideoIoGenerateContract } from "@vm0/api-contracts/contracts/zero-video-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import {
  checkVideoCredits$,
  downloadFalVideo,
  parseFalVideoResult,
  parseVideoOptions,
  recordGeneratedVideo$,
  submitFalVideoGeneration,
  videoInsufficientCredits,
  videoPricing$,
  videoPricingCategoryForOptions,
  videoPricingKey,
  videoServiceUnavailable,
  waitForFalVideoResult,
} from "../services/zero-video-io-generate.service";

const videoBody$ = bodyResultOf(zeroVideoIoGenerateContract.post);

function isErrorResponse(value: unknown): value is { readonly status: number } {
  return typeof value === "object" && value !== null && "status" in value;
}

const postVideoInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(videoBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const options = parseVideoOptions(bodyResult.data);
  if ("status" in options) {
    return options;
  }

  const hasCredits = await set(
    checkVideoCredits$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (!hasCredits) {
    return videoInsufficientCredits();
  }

  const pricing = await get(videoPricing$);
  signal.throwIfAborted();
  const pricingCategory = videoPricingCategoryForOptions(options);
  const pricingRow = pricing.get(
    videoPricingKey(options.model, pricingCategory),
  );
  if (!pricingRow) {
    return videoServiceUnavailable(
      "Video generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const falKey = env("FAL_KEY");
  if (!falKey) {
    return videoServiceUnavailable(
      "Fal video generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  const queueHandle = await submitFalVideoGeneration(options, falKey, signal);
  signal.throwIfAborted();
  if ("status" in queueHandle) {
    return queueHandle;
  }

  const resultBody = await waitForFalVideoResult(queueHandle, falKey, signal);
  signal.throwIfAborted();
  if (isErrorResponse(resultBody)) {
    return resultBody;
  }

  const falResult = parseFalVideoResult(resultBody, queueHandle.requestId);
  if ("status" in falResult) {
    return falResult;
  }

  const generation = await downloadFalVideo(falResult, options, signal);
  signal.throwIfAborted();
  if ("status" in generation) {
    return generation;
  }

  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const result = await set(
    recordGeneratedVideo$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      pricing: pricingRow,
      generation,
    },
    signal,
  );

  return { status: 200 as const, body: result };
});

export const zeroVideoIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: zeroVideoIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postVideoInner$,
    ),
  },
];
