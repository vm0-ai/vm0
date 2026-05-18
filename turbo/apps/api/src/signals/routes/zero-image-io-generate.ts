import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import {
  checkImageCredits$,
  getMissingImagePricing,
  imagePricing$,
  insufficientCredits,
  parseImageOptions,
  serviceUnavailable,
  submitFalImageQueueGeneration,
  type ImageOptions,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/zero-built-in-generation.service";
import { falBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";
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

function acceptedImageResponse(
  generationId: string,
  realtime: ZeroBuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "image" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

const submitImageProviderWebhookJob$ = command(
  async (
    { set },
    args: ImageJobArgs,
    signal: AbortSignal,
  ): Promise<GenerationErrorResponse | null> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const falKey = env("FAL_KEY");
    if (!falKey) {
      return serviceUnavailable(
        "Fal image generation is not configured",
        "NOT_CONFIGURED",
      );
    }
    const handle = await submitFalImageQueueGeneration(
      args.options,
      falKey,
      falBuiltInGenerationWebhookUrl({ generationId: args.generationId }),
      signal,
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
          providerTask: "image",
        },
      },
      signal,
    );
    return null;
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
    L.error("Image generation pricing is not configured", {
      model: options.model,
      missingPricing,
    });
    return serviceUnavailable(
      "Image generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  if (!env("FAL_KEY")) {
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
      request: builtInGenerationRequestWithInternal(
        imageRequestRecord(options),
        {
          admissionId: admission?.id,
        },
      ),
    },
    signal,
  );

  const submitError = await set(
    submitImageProviderWebhookJob$,
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

  return acceptedImageResponse(generationId, realtime);
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
