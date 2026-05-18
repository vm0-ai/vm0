import { command } from "ccstate";
import { webhookBuiltInGenerationFalContract } from "@vm0/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route";
import { safeJsonParse } from "../utils";
import {
  downloadFalImage,
  getMissingImagePricing,
  imagePricing$,
  parseFalImageResult,
  parseImageOptions,
  recordGeneratedImage$,
  type ImageOptions,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import {
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJob$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "../services/zero-built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/zero-run-built-in-admission.service";
import { verifyBuiltInGenerationProviderWebhookToken } from "../services/built-in-generation-provider-webhooks.service";
import {
  downloadFalVideo,
  parseFalVideoResult,
  parseVideoOptions,
  recordGeneratedVideo$,
  type VideoPricingRow,
  videoPricing$,
  videoPricingCategoryForOptions,
  videoPricingKey,
} from "../services/zero-video-io-generate.service";
import { logger } from "../../lib/log";

const L = logger("BuiltInGenerationWebhooks");

const falWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationFalContract.post,
);
const falWebhookQuery$ = queryOf(webhookBuiltInGenerationFalContract.post);

interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type FalWebhookResponse =
  | {
      readonly status: 200;
      readonly body: "OK";
    }
  | {
      readonly status: 400 | 401 | 503;
      readonly body: {
        readonly error: string;
      };
    };

function okResponse(): FalWebhookResponse {
  return { status: 200, body: "OK" };
}

function jsonError(
  message: string,
  status: 400 | 401 | 503,
): FalWebhookResponse {
  return { status, body: { error: message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorResponse(value: unknown): value is GenerationErrorResponse {
  if (!isRecord(value) || !isRecord(value.body)) {
    return false;
  }
  return isRecord(value.body.error);
}

function admissionForJob(
  job: BuiltInGenerationWebhookJob,
): RunBuiltInAdmission | null {
  const internal = readBuiltInGenerationRequestInternal(job.request);
  return internal.admissionId ? { id: internal.admissionId } : null;
}

const completeAdmissionForJob$ = command(
  async (
    { set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly status: "completed" | "failed";
    },
  ): Promise<void> => {
    await set(completeRunBuiltInAdmission$, {
      admission: admissionForJob(args.job),
      status: args.status,
    });
  },
);

function parseJobImageOptions(job: BuiltInGenerationWebhookJob): ImageOptions {
  const options = parseImageOptions(job.request);
  if (isErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function parseJobVideoOptions(job: BuiltInGenerationWebhookJob) {
  const options = parseVideoOptions(job.request);
  if (isErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function failError(message: string, code = "INTERNAL_SERVER_ERROR") {
  return { message, code };
}

function activeImagePricing(
  pricing: ImagePricing,
  options: ImageOptions,
): ImagePricing | GenerationErrorResponse {
  const missing = getMissingImagePricing(pricing, options.model);
  if (missing.length > 0) {
    return {
      status: 503,
      body: {
        error: {
          message: "Image generation pricing is not configured",
          code: "NOT_CONFIGURED",
        },
      },
    };
  }
  return pricing;
}

function activeVideoPricing(
  pricing: ReadonlyMap<string, VideoPricingRow>,
  job: BuiltInGenerationWebhookJob,
): VideoPricingRow | GenerationErrorResponse {
  const options = parseJobVideoOptions(job);
  const row = pricing.get(
    videoPricingKey(options.model, videoPricingCategoryForOptions(options)),
  );
  if (!row) {
    return {
      status: 503,
      body: {
        error: {
          message: "Video generation pricing is not configured",
          code: "NOT_CONFIGURED",
        },
      },
    };
  }
  return row;
}

function falPayloadBody(payload: unknown): {
  readonly status: string | undefined;
  readonly body: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const body =
    isRecord(payload.payload) || Array.isArray(payload.payload)
      ? payload.payload
      : isRecord(payload.data) || Array.isArray(payload.data)
        ? payload.data
        : isRecord(payload.response) || Array.isArray(payload.response)
          ? payload.response
          : payload;
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    body,
  };
}

const handleFalImageCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobImageOptions(args.job);
    const falResult = parseFalImageResult(args.payload);
    if (isErrorResponse(falResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadFalImage(falResult, options, signal);
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const imagePricing = await get(imagePricing$);
    signal.throwIfAborted();
    const pricing = activeImagePricing(imagePricing, options);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedImage$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "image",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleFalVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobVideoOptions(args.job);
    const videoPricing = await get(videoPricing$);
    signal.throwIfAborted();
    const pricing = activeVideoPricing(videoPricing, args.job);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const falResult = parseFalVideoResult(
      args.payload,
      readBuiltInGenerationRequestInternal(args.job.request).providerJobId,
    );
    if (isErrorResponse(falResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadFalVideo(falResult, options, signal);
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "video",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const postFalBuiltInGenerationWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<FalWebhookResponse> => {
    const params = get(falWebhookPathParams$);
    const query = get(falWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "fal",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("Fal built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    const payload = falPayloadBody(parsed);
    if (!payload) {
      L.warn("Fal built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }
    L.debug("Fal built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("Fal built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    const status = payload.status?.toUpperCase();
    if (status === "ERROR" || status === "FAILED") {
      L.warn("Fal built-in generation webhook reported failed generation", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: failError("Generation failed"),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    if (job.type === "image") {
      await set(
        handleFalImageCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("Fal built-in generation image webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }
    if (job.type === "video") {
      await set(
        handleFalVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("Fal built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    L.debug("Fal built-in generation webhook ignored unsupported job type", {
      generationId: job.id,
      type: job.type,
      visualKey: query.visualKey,
    });
    return okResponse();
  },
);

export const webhooksBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: webhookBuiltInGenerationFalContract.post,
    handler: postFalBuiltInGenerationWebhook$,
  },
];
