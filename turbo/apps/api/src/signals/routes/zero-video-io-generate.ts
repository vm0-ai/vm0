import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroVideoIoGenerateContract } from "@vm0/api-contracts/contracts/zero-video-io-generate";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import {
  bytePlusBuiltInGenerationWebhookUrl,
  falBuiltInGenerationWebhookUrl,
} from "../services/built-in-generation-provider-webhooks.service";
import {
  checkVideoCredits$,
  parseVideoOptions,
  submitBytePlusVideoGeneration,
  submitFalVideoGeneration,
  type VideoOptions,
  type VideoPricingRow,
  videoProviderForModel,
  videoInsufficientCredits,
  videoPricing$,
  videoPricingCategoryForOptions,
  videoPricingKey,
  videoServiceUnavailable,
} from "../services/zero-video-io-generate.service";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/zero-built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/zero-run-built-in-admission.service";

const videoBody$ = bodyResultOf(zeroVideoIoGenerateContract.post);

interface GenerationError {
  readonly message: string;
  readonly code: string;
}

interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: GenerationError;
  };
}

interface VideoJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: VideoOptions;
  readonly pricing: VideoPricingRow;
}

function isGenerationError(value: unknown): value is GenerationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    "code" in value
  );
}

function isErrorResponse(value: unknown): value is GenerationErrorResponse {
  if (typeof value !== "object" || value === null || !("body" in value)) {
    return false;
  }
  const body = value.body;
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    isGenerationError(body.error)
  );
}

function videoRequestRecord(options: VideoOptions): Record<string, unknown> {
  return {
    model: options.model,
    prompt: options.prompt,
    aspectRatio: options.aspectRatio,
    duration: options.duration,
    resolution: options.resolution,
    generateAudio: options.generateAudio,
    ...(options.negativePrompt
      ? { negativePrompt: options.negativePrompt }
      : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    autoFix: options.autoFix,
    safetyTolerance: options.safetyTolerance,
    ...(options.referenceImageUrls.length > 0
      ? { referenceImageUrls: options.referenceImageUrls }
      : {}),
    ...(options.inputVideoUrls.length > 0
      ? { inputVideoUrls: options.inputVideoUrls }
      : {}),
    ...(options.referenceAudioUrls.length > 0
      ? { referenceAudioUrls: options.referenceAudioUrls }
      : {}),
    ...(options.firstFrameImageUrl
      ? { firstFrameImageUrl: options.firstFrameImageUrl }
      : {}),
    ...(options.lastFrameImageUrl
      ? { lastFrameImageUrl: options.lastFrameImageUrl }
      : {}),
  };
}

function acceptedVideoResponse(
  generationId: string,
  realtime: ZeroBuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "video" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

const submitVideoProviderWebhookJob$ = command(
  async (
    { set },
    args: VideoJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const provider = videoProviderForModel(args.options.model);
    if (provider === "fal") {
      const handle = await submitFalVideoGeneration(
        args.options,
        env("FAL_KEY") ?? "",
        signal,
        falBuiltInGenerationWebhookUrl({
          generationId: args.generationId,
        }),
      );
      signal.throwIfAborted();
      if (isErrorResponse(handle)) {
        await set(
          failBuiltInGenerationJob$,
          { generationId: args.generationId, error: handle.body.error },
          signal,
        );
        return handle;
      }
      await set(
        mergeBuiltInGenerationJobInternal$,
        {
          generationId: args.generationId,
          internal: {
            provider: "fal",
            providerJobId: handle.requestId,
            providerStatusUrl: handle.statusUrl,
            providerResponseUrl: handle.responseUrl,
            providerTask: "video",
          },
        },
        signal,
      );
      return null;
    }

    const handle = await submitBytePlusVideoGeneration(
      args.options,
      env("BYTEPLUS_API_KEY") ?? "",
      signal,
      bytePlusBuiltInGenerationWebhookUrl({
        generationId: args.generationId,
      }),
    );
    signal.throwIfAborted();
    if (isErrorResponse(handle)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: handle.body.error },
        signal,
      );
      return handle;
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId: args.generationId,
        internal: {
          provider: "byteplus",
          providerJobId: handle.taskId,
          providerTask: "video",
        },
      },
      signal,
    );
    return null;
  },
);

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

  const provider = videoProviderForModel(options.model);
  if (provider === "fal" && !env("FAL_KEY")) {
    return videoServiceUnavailable(
      "Fal video generation is not configured",
      "NOT_CONFIGURED",
    );
  }
  if (provider === "byteplus" && !env("BYTEPLUS_API_KEY")) {
    return videoServiceUnavailable(
      "BytePlus video generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  const generationId = randomUUID();
  const realtime = await createBuiltInGenerationRealtimeSubscription(
    auth.userId,
    generationId,
  );
  signal.throwIfAborted();
  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const admission = await set(
    startRunBuiltInAdmission$,
    { runId, kind: "video" },
    signal,
  );
  if (isRunBuiltInAdmissionError(admission)) {
    return admission;
  }

  await set(
    createBuiltInGenerationJob$,
    {
      generationId,
      type: "video",
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      request: builtInGenerationRequestWithInternal(
        videoRequestRecord(options),
        {
          admissionId: admission?.id,
        },
      ),
    },
    signal,
  );
  const submitError = await set(
    submitVideoProviderWebhookJob$,
    {
      generationId,
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      admission,
      options,
      pricing: pricingRow,
    },
    signal,
  );
  signal.throwIfAborted();
  if (submitError) {
    await set(completeRunBuiltInAdmission$, {
      admission,
      status: "failed",
    });
    signal.throwIfAborted();
    return submitError;
  }

  return acceptedVideoResponse(generationId, realtime);
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
