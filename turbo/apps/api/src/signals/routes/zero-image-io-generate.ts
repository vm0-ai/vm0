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
  downloadFalImage,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  internalError,
  OPENAI_IMAGE_GENERATION_URL,
  parseImageGenerationResult,
  parseFalImageResult,
  parseImageOptions,
  recordGeneratedImage$,
  serviceUnavailable,
  submitFalImageGeneration,
  type ImageOptions,
} from "../services/zero-image-io-generate.service";

const L = logger("ZeroImageIoGenerate");
const imageBody$ = bodyResultOf(zeroImageIoGenerateContract.post);

type ImageErrorResponse = {
  readonly status: number;
  readonly body: unknown;
};

function isImageErrorResponse(value: unknown): value is ImageErrorResponse {
  return typeof value === "object" && value !== null && "status" in value;
}

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

  const generation =
    options.provider === "fal"
      ? await generateFalImage(options, signal)
      : await generateOpenAiImage(options, signal);
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

async function generateOpenAiImage(options: ImageOptions, signal: AbortSignal) {
  const response = await fetch(OPENAI_IMAGE_GENERATION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      n: 1,
      size: options.size,
      quality: options.quality,
      background: options.background,
      output_format: options.outputFormat,
      ...(options.outputCompression !== undefined
        ? { output_compression: options.outputCompression }
        : {}),
      moderation: options.moderation,
    }),
    signal,
  });
  signal.throwIfAborted();

  if (!response.ok) {
    const errorBody = await response.text();
    signal.throwIfAborted();
    L.error("OpenAI image request failed", {
      status: response.status,
      body: errorBody,
    });
    return internalError("Image generation failed");
  }

  const responseBody: unknown = await response.json();
  signal.throwIfAborted();
  const generation = parseImageGenerationResult(responseBody, options);
  if (
    "status" in generation &&
    generation.body.error.code === "USAGE_UNKNOWN"
  ) {
    L.error("OpenAI image response missing usage", { responseBody });
  }
  return generation;
}

async function generateFalImage(options: ImageOptions, signal: AbortSignal) {
  const falKey = env("FAL_KEY");
  if (!falKey) {
    return serviceUnavailable(
      "Fal image generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  const responseBody = await submitFalImageGeneration(options, falKey, signal);
  signal.throwIfAborted();
  if (isImageErrorResponse(responseBody)) {
    return responseBody;
  }

  const falResult = parseFalImageResult(responseBody);
  if ("status" in falResult) {
    return falResult;
  }
  return await downloadFalImage(falResult, options, signal);
}

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
