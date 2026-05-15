import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroVideoIoGenerateContract } from "@vm0/api-contracts/contracts/zero-video-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import { safeAsync } from "../utils";
import {
  checkVideoCredits$,
  downloadFalVideo,
  parseFalVideoResult,
  parseVideoOptions,
  recordGeneratedVideo$,
  submitFalVideoGeneration,
  type VideoOptions,
  type VideoPricingRow,
  videoInsufficientCredits,
  videoPricing$,
  videoPricingCategoryForOptions,
  videoPricingKey,
  videoServiceUnavailable,
  waitForFalVideoResult,
} from "../services/zero-video-io-generate.service";
import {
  completeBuiltInGenerationJob$,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  refreshActiveBuiltInGenerationJob$,
} from "../services/zero-built-in-generation.service";

const L = logger("ZeroVideoIoGenerate");
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
  readonly options: VideoOptions;
  readonly pricing: VideoPricingRow;
  readonly falKey: string;
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
  };
}

const runVideoGenerationJob$ = command(
  async ({ set }, args: VideoJobArgs, signal: AbortSignal): Promise<void> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const queueHandle = await submitFalVideoGeneration(
      args.options,
      args.falKey,
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(queueHandle)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: queueHandle.body.error },
        signal,
      );
      return;
    }

    const resultBody = await waitForFalVideoResult(
      queueHandle,
      args.falKey,
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(resultBody)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: resultBody.body.error },
        signal,
      );
      return;
    }

    const falResult = parseFalVideoResult(resultBody, queueHandle.requestId);
    if (isErrorResponse(falResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: falResult.body.error },
        signal,
      );
      return;
    }

    const generation = await downloadFalVideo(falResult, args.options, signal);
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: generation.body.error },
        signal,
      );
      return;
    }

    const active = await set(
      refreshActiveBuiltInGenerationJob$,
      { generationId: args.generationId, type: "video" },
      signal,
    );
    if (!active) {
      return;
    }

    const result = await set(
      recordGeneratedVideo$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        pricing: args.pricing,
        generation,
        usageIdempotency: {
          generationId: args.generationId,
          scope: "video",
        },
      },
      signal,
    );

    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.generationId, result },
      signal,
    );
  },
);

const runVideoGenerationJobSafely$ = command(
  async ({ set }, args: VideoJobArgs, signal: AbortSignal): Promise<void> => {
    const result = await safeAsync(async () => {
      await set(runVideoGenerationJob$, args, signal);
    });
    signal.throwIfAborted();
    if ("ok" in result) {
      return;
    }

    L.error("Built-in video generation job failed", result.error);
    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Video generation failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      signal,
    );
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

  const falKey = env("FAL_KEY");
  if (!falKey) {
    return videoServiceUnavailable(
      "Fal video generation is not configured",
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
  await set(
    createBuiltInGenerationJob$,
    {
      generationId,
      type: "video",
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      request: videoRequestRecord(options),
    },
    signal,
  );
  waitUntil(
    set(
      runVideoGenerationJobSafely$,
      {
        generationId,
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        options,
        pricing: pricingRow,
        falKey,
      },
      signal,
    ),
  );

  return {
    status: 202 as const,
    body: {
      generationId,
      type: "video" as const,
      status: "queued" as const,
      realtime,
    },
  };
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
