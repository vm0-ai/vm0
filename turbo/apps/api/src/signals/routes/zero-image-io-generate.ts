import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";

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
  checkImageCredits$,
  generateImageWithProvider,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  parseImageOptions,
  recordGeneratedImage$,
  serviceUnavailable,
  type ImageOptions,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import {
  completeBuiltInGenerationJob$,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  refreshActiveBuiltInGenerationJob$,
} from "../services/zero-built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/zero-run-built-in-admission.service";

const L = logger("ZeroImageIoGenerate");
const imageBody$ = bodyResultOf(zeroImageIoGenerateContract.post);

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

interface ImageJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: ImageOptions;
  readonly pricing: ImagePricing;
}

type AdmissionCompletionStatus = "completed" | "failed";

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

function imageRequestRecord(options: ImageOptions): Record<string, unknown> {
  return {
    model: options.model,
    provider: options.provider,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality,
    background: options.background,
    outputFormat: options.outputFormat,
    ...(options.outputCompression !== undefined
      ? { outputCompression: options.outputCompression }
      : {}),
    moderation: options.moderation,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    safetyTolerance: options.safetyTolerance,
    enhancePrompt: options.enhancePrompt,
  };
}

const runImageGenerationJob$ = command(
  async (
    { set },
    args: ImageJobArgs,
    signal: AbortSignal,
  ): Promise<AdmissionCompletionStatus> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const generation = await generateImageWithProvider(args.options, signal);
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: generation.body.error },
        signal,
      );
      return "failed";
    }

    const active = await set(
      refreshActiveBuiltInGenerationJob$,
      { generationId: args.generationId, type: "image" },
      signal,
    );
    if (!active) {
      return "failed";
    }

    const result = await set(
      recordGeneratedImage$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        pricing: args.pricing,
        generation,
        usageIdempotency: {
          generationId: args.generationId,
          scope: "image",
        },
      },
      signal,
    );

    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.generationId, result },
      signal,
    );
    return "completed";
  },
);

const runImageGenerationJobSafely$ = command(
  async ({ set }, args: ImageJobArgs, signal: AbortSignal): Promise<void> => {
    const result = await safeAsync(async () => {
      return await set(runImageGenerationJob$, args, signal);
    });
    signal.throwIfAborted();
    const admissionStatus: AdmissionCompletionStatus =
      "ok" in result ? result.ok : "failed";
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: admissionStatus,
    });
    signal.throwIfAborted();
    if ("ok" in result) {
      return;
    }

    L.error("Built-in image generation job failed", result.error);
    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Image generation failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      signal,
    );
  },
);

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

  if (options.provider === "fal" && !env("FAL_KEY")) {
    return serviceUnavailable(
      "Fal image generation is not configured",
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
    { runId, kind: "image" },
    signal,
  );
  if (isRunBuiltInAdmissionError(admission)) {
    return admission;
  }

  await set(
    createBuiltInGenerationJob$,
    {
      generationId,
      type: "image",
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      request: imageRequestRecord(options),
    },
    signal,
  );
  waitUntil(
    set(
      runImageGenerationJobSafely$,
      {
        generationId,
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        admission,
        options,
        pricing,
      },
      signal,
    ),
  );

  return {
    status: 202 as const,
    body: {
      generationId,
      type: "image" as const,
      status: "queued" as const,
      realtime,
    },
  };
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
