import { command } from "ccstate";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import {
  checkImageCredits$,
  imagePricing$,
  IMAGE_IO_MODEL,
  insufficientCredits,
  internalError,
  OPENAI_IMAGE_GENERATION_URL,
  parseImageGenerationResult,
  parseImageOptions,
  recordGeneratedImage$,
  serviceUnavailable,
} from "../services/zero-image-io-generate.service";

const L = logger("ZeroImageIoGenerate");
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
  if (!pricing) {
    return serviceUnavailable(
      "Image generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const openaiResponse = await fetch(OPENAI_IMAGE_GENERATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: IMAGE_IO_MODEL,
      prompt: options.prompt,
      n: 1,
      size: options.size,
      quality: options.quality,
      background: options.background,
      output_format: options.outputFormat,
    }),
    signal,
  });
  signal.throwIfAborted();

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    signal.throwIfAborted();
    L.error("OpenAI image request failed", {
      status: openaiResponse.status,
      body: errorBody,
    });
    return internalError("Image generation failed");
  }

  const responseBody: unknown = await openaiResponse.json();
  signal.throwIfAborted();
  const generation = parseImageGenerationResult(responseBody, options);
  if ("status" in generation) {
    if (generation.body.error.code === "USAGE_UNKNOWN") {
      L.error("OpenAI image response missing usage", { responseBody });
    }
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
