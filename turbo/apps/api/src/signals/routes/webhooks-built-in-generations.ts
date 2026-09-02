import { command } from "ccstate";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookBuiltInGenerationJoggAiContract,
  webhookBuiltInGenerationMiniMaxContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse, tapError } from "../utils";
import {
  downloadFalImage,
  getFalImageBillableUnits,
  getMissingImagePricing,
  imagePricing$,
  parseFalImageResult,
  parseImageOptions,
  recordGeneratedImage$,
  type ImageOptions,
  type ImagePricing,
} from "../services/image-generation.service";
import {
  builtInGenerationPublicBrand,
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJobByProviderJobId$,
  getBuiltInGenerationWebhookJob$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "../services/built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/run-built-in-admission.service";
import {
  verifyBuiltInGenerationProviderWebhookToken,
  verifyJoggAiWebhookSignature,
} from "../services/built-in-generation-provider-webhooks.service";
import {
  bytePlusBuiltInGenerationError,
  downloadBytePlusVideo,
  downloadFalVideo,
  downloadMiniMaxVideo,
  getMissingVideoPricing,
  miniMaxBuiltInGenerationError,
  parseBytePlusVideoResult,
  parseFalVideoResult,
  parseMiniMaxVideoResult,
  parseVideoOptions,
  recordGeneratedVideo$,
  type VideoPricing,
  videoPricing$,
} from "../services/video-generation.service";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import {
  avatarVideoPricing$,
  downloadJoggAiAvatarVideo,
  isAvatarVideoErrorResponse,
  parseAvatarVideoOptions,
  parseJoggAiWebhookPayload,
  recordGeneratedAvatarVideo$,
} from "../services/avatar-video.service";

const L = logger("BuiltInGenerationWebhooks");

const falWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationFalContract.post,
);
const falWebhookQuery$ = queryOf(webhookBuiltInGenerationFalContract.post);
const bytePlusWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationBytePlusContract.post,
);
const bytePlusWebhookQuery$ = queryOf(
  webhookBuiltInGenerationBytePlusContract.post,
);
const miniMaxWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationMiniMaxContract.post,
);
const miniMaxWebhookQuery$ = queryOf(
  webhookBuiltInGenerationMiniMaxContract.post,
);
interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type ProviderWebhookResponse =
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

type MiniMaxWebhookResponse =
  | ProviderWebhookResponse
  | {
      readonly status: 200;
      readonly body: { readonly challenge: string };
    };

function okResponse(): ProviderWebhookResponse {
  return { status: 200, body: "OK" };
}

function jsonError(
  message: string,
  status: 400 | 401 | 503,
): ProviderWebhookResponse {
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

function parseJobAvatarVideoOptions(job: BuiltInGenerationWebhookJob) {
  const options = parseAvatarVideoOptions(job.request);
  if (isAvatarVideoErrorResponse(options)) {
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
  pricing: VideoPricing,
  job: BuiltInGenerationWebhookJob,
): VideoPricing | GenerationErrorResponse {
  const options = parseJobVideoOptions(job);
  if (getMissingVideoPricing(pricing, options).length > 0) {
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
  return pricing;
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

function bytePlusPayloadBody(payload: unknown): {
  readonly status: string | undefined;
  readonly body: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    body: payload,
  };
}

function miniMaxPayloadBody(payload: unknown): {
  readonly status: string;
  readonly body: Record<string, unknown>;
} | null {
  if (!isRecord(payload) || !isRecord(payload.task)) {
    return null;
  }
  const status = payload.task.status;
  if (typeof status !== "string" || status.length === 0) {
    return null;
  }
  return { status, body: payload.task };
}

const PROVIDER_FAILURE_DETAIL_KEYS = [
  "reason",
  "failure_reason",
  "failureReason",
  "error",
  "error_message",
  "errorMessage",
  "message",
  "msg",
  "detail",
  "description",
  "status_message",
  "statusMessage",
  "err_msg",
  "code",
  "error_code",
  "errorCode",
  "logs",
] as const;

function providerFailureLogKey(key: string): string {
  switch (key) {
    case "failure_reason": {
      return "failureReason";
    }
    case "error_message": {
      return "errorMessage";
    }
    case "err_msg": {
      return "errorMessage";
    }
    case "msg": {
      return "message";
    }
    case "status_message": {
      return "statusMessage";
    }
    case "error_code": {
      return "errorCode";
    }
    default: {
      return key;
    }
  }
}

function truncateProviderFailureDetail(value: string): string {
  const maxLength = 1000;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

const MAX_PROVIDER_FAILURE_DETAIL_DEPTH = 5;

function scalarProviderFailureDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed
      ? truncateProviderFailureDetail(redactPresignedUrls(trimmed))
      : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function stringifyProviderFailureDetail(
  value: unknown,
  depth = 0,
): string | undefined {
  const scalar = scalarProviderFailureDetail(value);
  if (scalar) {
    return scalar;
  }
  if (depth >= MAX_PROVIDER_FAILURE_DETAIL_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        return stringifyProviderFailureDetail(item, depth + 1);
      })
      .filter((item): item is string => {
        return Boolean(item);
      })
      .join("\n");
    return text ? truncateProviderFailureDetail(text) : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of PROVIDER_FAILURE_DETAIL_KEYS) {
    const detail = stringifyProviderFailureDetail(value[key], depth + 1);
    if (detail) {
      return detail;
    }
  }
  // Deliberately no JSON.stringify fallback: an unrecognized object is the
  // provider echoing our request back, and serializing it put user prompts and
  // reference image URLs into production logs.
  return undefined;
}

export function providerFailureDetailsForLog(
  payload: unknown,
): Record<string, string> {
  if (!isRecord(payload)) {
    return {};
  }
  const details: Record<string, string> = {};
  for (const source of [
    payload,
    payload.payload,
    payload.data,
    payload.response,
  ]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const key of PROVIDER_FAILURE_DETAIL_KEYS) {
      const value = stringifyProviderFailureDetail(source[key]);
      if (value) {
        details[providerFailureLogKey(key)] ??= value;
      }
    }
  }
  return details;
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
    const falBillableUnits = await getFalImageBillableUnits(
      options,
      readBuiltInGenerationRequestInternal(args.job.request)
        .providerResponseUrl,
      env("FAL_KEY"),
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(falBillableUnits)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falBillableUnits.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadFalImage(
      falResult,
      options,
      falBillableUnits,
      signal,
    );
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
        publicBrand: builtInGenerationPublicBrand(args.job.request),
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

const handleBytePlusVideoCompletion$ = command(
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
    const bytePlusResult = parseBytePlusVideoResult(args.payload);
    if (isErrorResponse(bytePlusResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: bytePlusResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadBytePlusVideo(
      bytePlusResult,
      options,
      signal,
    );
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
        publicBrand: builtInGenerationPublicBrand(args.job.request),
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

const handleMiniMaxVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobVideoOptions(args.job);
    const miniMaxResult = parseMiniMaxVideoResult(args.payload);
    if (isErrorResponse(miniMaxResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: miniMaxResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

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

    const generation = await downloadMiniMaxVideo(
      miniMaxResult,
      options,
      signal,
    );
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
        publicBrand: builtInGenerationPublicBrand(args.job.request),
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
        publicBrand: builtInGenerationPublicBrand(args.job.request),
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

const handleJoggAiAvatarVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: Extract<
        ReturnType<typeof parseJoggAiWebhookPayload>,
        { readonly kind: "completed" }
      >;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobAvatarVideoOptions(args.job);
    const pricing = await get(avatarVideoPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.job.id,
          error: failError(
            "JoggAI avatar video pricing is not configured",
            "NOT_CONFIGURED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadJoggAiAvatarVideo(
      args.payload,
      options,
      signal,
    );
    signal.throwIfAborted();
    if (isAvatarVideoErrorResponse(generation)) {
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
      recordGeneratedAvatarVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "avatar-video",
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
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
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
      const failureDetails = providerFailureDetailsForLog(parsed);
      L.warn("Fal built-in generation webhook reported failed generation", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
        ...failureDetails,
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

const postBytePlusBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const params = get(bytePlusWebhookPathParams$);
    const query = get(bytePlusWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "byteplus",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("BytePlus built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    const payload = bytePlusPayloadBody(parsed);
    if (!payload) {
      L.warn("BytePlus built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }

    const status = payload.status?.toLowerCase();
    L.debug("BytePlus built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });

    if (status === "queued" || status === "running") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("BytePlus built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (status === "failed" || status === "expired") {
      const failureDetails = providerFailureDetailsForLog(parsed);
      L.warn(
        "BytePlus built-in generation webhook reported failed generation",
        {
          generationId: job.id,
          type: job.type,
          status: payload.status,
          visualKey: query.visualKey,
          ...failureDetails,
        },
      );
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: bytePlusBuiltInGenerationError(parsed),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    if (status && status !== "succeeded") {
      L.debug("BytePlus built-in generation webhook ignored status", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (job.type === "video") {
      await set(
        handleBytePlusVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("BytePlus built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    L.debug(
      "BytePlus built-in generation webhook ignored unsupported job type",
      {
        generationId: job.id,
        type: job.type,
        visualKey: query.visualKey,
      },
    );
    return okResponse();
  },
);

const postMiniMaxBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<MiniMaxWebhookResponse> => {
    const params = get(miniMaxWebhookPathParams$);
    const query = get(miniMaxWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "minimax",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("MiniMax built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    if (isRecord(parsed) && typeof parsed.challenge === "string") {
      return { status: 200, body: { challenge: parsed.challenge } };
    }

    const payload = miniMaxPayloadBody(parsed);
    if (!payload) {
      L.warn("MiniMax built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }

    const status = payload.status.toLowerCase();
    L.debug("MiniMax built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });
    if (status === "queued" || status === "running") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("MiniMax built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (status === "failed" || status === "cancelled" || status === "expired") {
      const failureDetails = providerFailureDetailsForLog(payload.body);
      L.warn("MiniMax built-in generation webhook reported failed generation", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
        ...failureDetails,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: miniMaxBuiltInGenerationError(payload.body),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    if (status !== "succeeded") {
      L.debug("MiniMax built-in generation webhook ignored status", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (job.type === "video") {
      await set(
        handleMiniMaxVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("MiniMax built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    L.debug(
      "MiniMax built-in generation webhook ignored unsupported job type",
      {
        generationId: job.id,
        type: job.type,
        visualKey: query.visualKey,
      },
    );
    return okResponse();
  },
);

const postJoggAiBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const webhookSecret = env("JOGGAI_WEBHOOK_SECRET");
    if (!webhookSecret) {
      L.error("JoggAI webhook signing secret is not configured");
      return jsonError("Webhook is not configured", 503);
    }

    const request = get(request$);
    const signature = request.header("x-webhook-signature");
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (
      !signature ||
      !verifyJoggAiWebhookSignature({
        body: rawBody,
        secret: webhookSecret,
        signature,
      })
    ) {
      L.warn("JoggAI built-in generation webhook rejected invalid signature");
      return jsonError("Invalid signature", 401);
    }

    const parsed = safeJsonParse(rawBody);
    const payload = parseJoggAiWebhookPayload(parsed);
    if (isAvatarVideoErrorResponse(payload)) {
      L.warn("JoggAI built-in generation webhook rejected invalid payload", {
        reason: payload.body.error.message,
      });
      return jsonError(payload.body.error.message, 400);
    }
    if (payload.kind === "pending") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJobByProviderJobId$,
      { provider: "joggai", providerJobId: payload.videoId },
      signal,
    );
    if (!job) {
      L.debug("JoggAI built-in generation webhook ignored inactive job", {
        providerVideoId: payload.videoId,
      });
      return okResponse();
    }

    if (payload.kind === "failed") {
      L.warn("JoggAI built-in generation webhook reported failure", {
        generationId: job.id,
        providerVideoId: payload.videoId,
        providerMessage: payload.message,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: failError(
            "JoggAI avatar video generation failed",
            "JOGGAI_GENERATION_FAILED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    waitUntil(
      tapError(
        set(handleJoggAiAvatarVideoCompletion$, { job, payload }, signal),
        (error) => {
          L.error("JoggAI built-in generation webhook processing failed", {
            generationId: job.id,
            providerVideoId: payload.videoId,
            error,
          });
        },
      ),
    );
    L.debug("JoggAI built-in generation webhook accepted", {
      generationId: job.id,
      providerVideoId: payload.videoId,
    });
    return okResponse();
  },
);

export const webhooksBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: webhookBuiltInGenerationFalContract.post,
    handler: postFalBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationBytePlusContract.post,
    handler: postBytePlusBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationMiniMaxContract.post,
    handler: postMiniMaxBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationJoggAiContract.post,
    handler: postJoggAiBuiltInGenerationWebhook$,
  },
];
