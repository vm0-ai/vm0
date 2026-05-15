import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import {
  webhookBuiltInGenerationFalContract,
  webhookBuiltInGenerationOpenAiContract,
} from "@vm0/api-contracts/contracts/webhooks";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
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
  parseOpenAiResponsesImageGenerationResult,
  recordGeneratedImage$,
  submitFalImageQueueGeneration,
  submitOpenAiImageBackgroundGeneration,
  type ImageOptions,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import {
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJob$,
  mergeBuiltInGenerationJobInternal$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "../services/zero-built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/zero-run-built-in-admission.service";
import {
  falBuiltInGenerationWebhookUrl,
  verifyBuiltInGenerationProviderWebhookToken,
} from "../services/built-in-generation-provider-webhooks.service";
import {
  createPresentationVisualGenerationTasks,
  parsePresentationGenerationResult,
  parsePresentationOptions,
  presentationPricing$,
  recordGeneratedPresentation$,
  type ParsedPresentationGeneration,
  type PresentationOptions,
  type PresentationPricing,
  type PresentationVisual,
  type PresentationVisualGenerationTask,
} from "../services/zero-presentation-io-generate.service";
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

const L = logger("BuiltInGenerationProviderWebhooks");
const falWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationFalContract.post,
);
const falWebhookQuery$ = queryOf(webhookBuiltInGenerationFalContract.post);

const OPENAI_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const OPENAI_FAILURE_EVENT_TYPES = [
  "response.failed",
  "response.cancelled",
  "response.incomplete",
] as const;

interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface StoredPresentationVisualTask {
  readonly key: string;
  readonly slideIndex: number;
  readonly prompt: string;
  readonly alt: string;
  readonly imageOptions: ImageOptions;
  readonly status: "running" | "completed" | "failed";
  readonly provider?: "openai" | "fal";
  readonly providerJobId?: string;
  readonly providerStatusUrl?: string;
  readonly providerResponseUrl?: string;
  readonly visual?: PresentationVisual;
}

interface StoredPresentationState {
  readonly generation: ParsedPresentationGeneration;
  readonly tasks: readonly StoredPresentationVisualTask[];
}

function jsonError(message: string, status: 400 | 401 | 503): Response {
  return Response.json({ error: message }, { status });
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

function openAiWebhookSigningKey(secret: string): Buffer {
  const serialized = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  return Buffer.from(serialized, "base64");
}

function verifyOpenAiWebhookSignature(args: {
  readonly rawBody: string;
  readonly headers: Headers;
  readonly secret: string;
}): boolean {
  const webhookId = args.headers.get("webhook-id");
  const timestamp = args.headers.get("webhook-timestamp");
  const signatureHeader = args.headers.get("webhook-signature");
  if (!webhookId || !timestamp || !signatureHeader) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(now() / 1000) - timestampSeconds) >
      OPENAI_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const signedPayload = `${webhookId}.${timestamp}.${args.rawBody}`;
  const expected = createHmac("sha256", openAiWebhookSigningKey(args.secret))
    .update(signedPayload)
    .digest();

  for (const signaturePart of signatureHeader.split(" ")) {
    const [version, signature] = signaturePart.split(",");
    if (version !== "v1" || !signature) {
      continue;
    }
    const actual = Buffer.from(signature, "base64");
    if (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    ) {
      return true;
    }
  }
  return false;
}

function openAiResponseIdFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event.data)) {
    return undefined;
  }
  return typeof event.data.id === "string" ? event.data.id : undefined;
}

function openAiEventType(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string"
    ? event.type
    : undefined;
}

function openAiResponseMetadata(responseBody: unknown): Record<string, string> {
  if (!isRecord(responseBody) || !isRecord(responseBody.metadata)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(responseBody.metadata).flatMap(([key, value]) => {
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
}

async function fetchOpenAiResponse(
  responseId: string,
  signal: AbortSignal,
): Promise<unknown | GenerationErrorResponse> {
  const response = await fetch(
    `https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      },
      signal,
    },
  );
  signal.throwIfAborted();
  if (!response.ok) {
    return {
      status: 502,
      body: {
        error: {
          message: "OpenAI response fetch failed",
          code: "OPENAI_RESPONSE_FETCH_FAILED",
        },
      },
    };
  }
  return await response.json();
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

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === "string";
    })
  );
}

function isStoredSlideSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.layout === "string" &&
    typeof value.kicker === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isStringArray(value.bullets) &&
    typeof value.metric === "string" &&
    typeof value.note === "string" &&
    typeof value.visualPrompt === "string"
  );
}

function isStoredPresentationGeneration(
  value: unknown,
): value is ParsedPresentationGeneration {
  return (
    isRecord(value) &&
    isRecord(value.deck) &&
    typeof value.deck.title === "string" &&
    typeof value.deck.subtitle === "string" &&
    Array.isArray(value.deck.slides) &&
    value.deck.slides.every(isStoredSlideSpec) &&
    isRecord(value.usage) &&
    typeof value.usage.inputTokens === "number" &&
    typeof value.usage.outputTokens === "number" &&
    typeof value.usage.totalTokens === "number" &&
    (value.responseId === undefined || typeof value.responseId === "string") &&
    typeof value.title === "string" &&
    typeof value.style === "string" &&
    typeof value.theme === "string" &&
    typeof value.slideCount === "number"
  );
}

function storedPresentationState(
  job: BuiltInGenerationWebhookJob,
): StoredPresentationState | null {
  const internal = readBuiltInGenerationRequestInternal(job.request);
  if (!isRecord(internal.presentation)) {
    return null;
  }
  const generation = internal.presentation.generation;
  const tasks = internal.presentation.tasks;
  if (!isStoredPresentationGeneration(generation) || !Array.isArray(tasks)) {
    return null;
  }
  const parsedTasks = tasks.flatMap((task): StoredPresentationVisualTask[] => {
    if (
      !isRecord(task) ||
      typeof task.key !== "string" ||
      typeof task.slideIndex !== "number" ||
      typeof task.prompt !== "string" ||
      typeof task.alt !== "string" ||
      !isRecord(task.imageOptions) ||
      (task.status !== "running" &&
        task.status !== "completed" &&
        task.status !== "failed")
    ) {
      return [];
    }
    const imageOptions = parseImageOptions(task.imageOptions);
    if (isErrorResponse(imageOptions)) {
      return [];
    }
    return [
      {
        key: task.key,
        slideIndex: task.slideIndex,
        prompt: task.prompt,
        alt: task.alt,
        imageOptions,
        status: task.status,
        provider:
          task.provider === "openai" || task.provider === "fal"
            ? task.provider
            : undefined,
        providerJobId:
          typeof task.providerJobId === "string"
            ? task.providerJobId
            : undefined,
        providerStatusUrl:
          typeof task.providerStatusUrl === "string"
            ? task.providerStatusUrl
            : undefined,
        providerResponseUrl:
          typeof task.providerResponseUrl === "string"
            ? task.providerResponseUrl
            : undefined,
        visual: isPresentationVisual(task.visual) ? task.visual : undefined,
      },
    ];
  });
  return {
    generation,
    tasks: parsedTasks,
  };
}

function isPresentationVisual(value: unknown): value is PresentationVisual {
  return (
    isRecord(value) &&
    typeof value.slideIndex === "number" &&
    typeof value.url === "string" &&
    typeof value.alt === "string" &&
    typeof value.prompt === "string" &&
    typeof value.imageId === "string" &&
    typeof value.filename === "string" &&
    typeof value.creditsCharged === "number"
  );
}

function completedPresentationVisuals(
  state: StoredPresentationState,
): readonly PresentationVisual[] {
  return state.tasks
    .flatMap((task): PresentationVisual[] => {
      return task.visual ? [task.visual] : [];
    })
    .sort((left, right) => {
      return left.slideIndex - right.slideIndex;
    });
}

function isOpenAiFailureEvent(eventType: string): boolean {
  return OPENAI_FAILURE_EVENT_TYPES.some((failureEventType) => {
    return failureEventType === eventType;
  });
}

function parseJobImageOptions(job: BuiltInGenerationWebhookJob): ImageOptions {
  const options = parseImageOptions(job.request);
  if (isErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function parseJobPresentationOptions(
  job: BuiltInGenerationWebhookJob,
): PresentationOptions {
  const options = parsePresentationOptions(job.request);
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

const handleOpenAiImageCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly responseBody: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobImageOptions(args.job);
    const generation = parseOpenAiResponsesImageGenerationResult(
      args.responseBody,
      options,
    );
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

async function submitPresentationVisualTasks(args: {
  readonly generationId: string;
  readonly tasks: readonly PresentationVisualGenerationTask[];
  readonly falKey: string | undefined;
  readonly signal: AbortSignal;
}): Promise<readonly StoredPresentationVisualTask[]> {
  const storedTasks: StoredPresentationVisualTask[] = [];
  for (const task of args.tasks) {
    if (task.imageOptions.provider === "fal") {
      if (!args.falKey) {
        storedTasks.push({
          key: task.key,
          slideIndex: task.slideIndex,
          prompt: task.prompt,
          alt: task.alt,
          imageOptions: task.imageOptions,
          status: "failed",
          provider: "fal",
        });
        continue;
      }
      const handle = await submitFalImageQueueGeneration(
        task.imageOptions,
        args.falKey,
        falBuiltInGenerationWebhookUrl({
          generationId: args.generationId,
          visualKey: task.key,
        }),
        args.signal,
      );
      args.signal.throwIfAborted();
      if (isErrorResponse(handle)) {
        storedTasks.push({
          key: task.key,
          slideIndex: task.slideIndex,
          prompt: task.prompt,
          alt: task.alt,
          imageOptions: task.imageOptions,
          status: "failed",
          provider: "fal",
        });
        continue;
      }
      storedTasks.push({
        key: task.key,
        slideIndex: task.slideIndex,
        prompt: task.prompt,
        alt: task.alt,
        imageOptions: task.imageOptions,
        status: "running",
        provider: "fal",
        providerJobId: handle.requestId,
        providerStatusUrl: handle.statusUrl,
        providerResponseUrl: handle.responseUrl,
      });
      continue;
    }

    const handle = await submitOpenAiImageBackgroundGeneration(
      task.imageOptions,
      {
        generationId: args.generationId,
        generationType: "presentation",
        task: "presentation-visual",
        visualKey: task.key,
      },
      args.signal,
    );
    args.signal.throwIfAborted();
    if (isErrorResponse(handle)) {
      storedTasks.push({
        key: task.key,
        slideIndex: task.slideIndex,
        prompt: task.prompt,
        alt: task.alt,
        imageOptions: task.imageOptions,
        status: "failed",
        provider: "openai",
      });
      continue;
    }
    storedTasks.push({
      key: task.key,
      slideIndex: task.slideIndex,
      prompt: task.prompt,
      alt: task.alt,
      imageOptions: task.imageOptions,
      status: "running",
      provider: "openai",
      providerJobId: handle.responseId,
    });
  }
  return storedTasks;
}

const finalizePresentationIfReady$ = command(
  async (
    { set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly state: StoredPresentationState;
      readonly options: PresentationOptions;
      readonly pricing: PresentationPricing;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const hasRunningTasks = args.state.tasks.some((task) => {
      return task.status === "running";
    });
    if (hasRunningTasks) {
      await set(
        mergeBuiltInGenerationJobInternal$,
        {
          generationId: args.job.id,
          internal: {
            presentation: args.state,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      return;
    }

    const result = await set(
      recordGeneratedPresentation$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        pricing: args.pricing,
        generation: args.state.generation,
        options: args.options,
        visuals: completedPresentationVisuals(args.state),
        usageIdempotency: {
          generationId: args.job.id,
          scope: "presentation-text",
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

const handleOpenAiPresentationDeckCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly responseBody: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobPresentationOptions(args.job);
    const generation = parsePresentationGenerationResult(
      args.responseBody,
      options,
    );
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

    const pricing = await get(presentationPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.job.id,
          error: failError(
            "Presentation generation pricing is not configured",
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

    const visualTasks = createPresentationVisualGenerationTasks(
      generation,
      options,
    );
    if (isErrorResponse(visualTasks)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: visualTasks.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    if (visualTasks.length === 0) {
      await set(
        finalizePresentationIfReady$,
        {
          job: args.job,
          state: { generation, tasks: [] },
          options,
          pricing,
        },
        signal,
      );
      return;
    }

    const storedTasks = await submitPresentationVisualTasks({
      generationId: args.job.id,
      tasks: visualTasks,
      falKey: env("FAL_KEY"),
      signal,
    });
    const state = { generation, tasks: storedTasks };
    await set(
      finalizePresentationIfReady$,
      { job: args.job, state, options, pricing },
      signal,
    );
  },
);

const handlePresentationVisualCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly visualKey: string;
      readonly providerBody: unknown;
      readonly provider: "openai" | "fal";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const state = storedPresentationState(args.job);
    if (!state) {
      L.warn("Presentation visual callback missing state", {
        generationId: args.job.id,
        visualKey: args.visualKey,
      });
      return;
    }
    const options = parseJobPresentationOptions(args.job);
    const pricing = await get(presentationPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.job.id,
          error: failError(
            "Presentation generation pricing is not configured",
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
    const imagePricing = await get(imagePricing$);
    signal.throwIfAborted();
    const updatedTasks = await Promise.all(
      state.tasks.map(async (task): Promise<StoredPresentationVisualTask> => {
        if (task.key !== args.visualKey || task.status !== "running") {
          return task;
        }
        const imageOptions = parseImageOptions(task.imageOptions);
        if (isErrorResponse(imageOptions)) {
          return { ...task, status: "failed" };
        }
        const imagePricingResult = activeImagePricing(
          imagePricing,
          imageOptions,
        );
        if (isErrorResponse(imagePricingResult)) {
          return { ...task, status: "failed" };
        }
        const generation =
          args.provider === "openai"
            ? parseOpenAiResponsesImageGenerationResult(
                args.providerBody,
                imageOptions,
              )
            : await (async () => {
                const falResult = parseFalImageResult(args.providerBody);
                if (isErrorResponse(falResult)) {
                  return falResult;
                }
                return await downloadFalImage(falResult, imageOptions, signal);
              })();
        signal.throwIfAborted();
        if (isErrorResponse(generation)) {
          return { ...task, status: "failed" };
        }
        const recorded = await set(
          recordGeneratedImage$,
          {
            orgId: args.job.orgId,
            userId: args.job.userId,
            runId: args.job.runId ?? undefined,
            pricing: imagePricingResult,
            generation,
            recordArtifact: false,
            usageIdempotency: {
              generationId: args.job.id,
              scope: `presentation-visual:${task.slideIndex}`,
            },
          },
          signal,
        );
        signal.throwIfAborted();
        return {
          ...task,
          status: "completed",
          visual: {
            slideIndex: task.slideIndex,
            url: recorded.url,
            alt: task.alt,
            prompt: task.prompt,
            imageId: recorded.id,
            filename: recorded.filename,
            creditsCharged: recorded.creditsCharged,
          },
        };
      }),
    );
    signal.throwIfAborted();
    await set(
      finalizePresentationIfReady$,
      {
        job: args.job,
        state: { generation: state.generation, tasks: updatedTasks },
        options,
        pricing,
      },
      signal,
    );
  },
);

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

const postOpenAiBuiltInGenerationWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const secret = optionalEnv("OPENAI_WEBHOOK_SECRET");
    if (!secret) {
      return jsonError("OpenAI webhook is not configured", 503);
    }
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (
      !verifyOpenAiWebhookSignature({
        rawBody,
        headers: request.raw.headers,
        secret,
      })
    ) {
      return jsonError("Invalid signature", 401);
    }

    const event = safeJsonParse(rawBody);
    const eventType = openAiEventType(event);
    const responseId = openAiResponseIdFromEvent(event);
    if (!eventType || !responseId) {
      return jsonError("Invalid payload", 400);
    }

    const responseBody = await fetchOpenAiResponse(responseId, signal);
    signal.throwIfAborted();
    if (isErrorResponse(responseBody)) {
      return jsonError(responseBody.body.error.message, 503);
    }
    const metadata = openAiResponseMetadata(responseBody);
    const generationId = metadata.built_in_generation_id;
    if (!generationId) {
      L.warn("OpenAI webhook response missing built-in generation metadata", {
        responseId,
        eventType,
      });
      return new Response("OK", { status: 200 });
    }
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      generationId,
      signal,
    );
    if (!job) {
      return new Response("OK", { status: 200 });
    }

    if (isOpenAiFailureEvent(eventType)) {
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
      return new Response("OK", { status: 200 });
    }

    if (eventType !== "response.completed") {
      return new Response("OK", { status: 200 });
    }

    const task = metadata.built_in_generation_task;
    if (task === "presentation-visual") {
      const visualKey = metadata.built_in_generation_visual_key;
      if (job.type !== "presentation" || !visualKey) {
        return new Response("OK", { status: 200 });
      }
      await set(
        handlePresentationVisualCompletion$,
        { job, visualKey, providerBody: responseBody, provider: "openai" },
        signal,
      );
      return new Response("OK", { status: 200 });
    }

    if (job.type === "image") {
      await set(handleOpenAiImageCompletion$, { job, responseBody }, signal);
      return new Response("OK", { status: 200 });
    }

    if (job.type === "presentation") {
      await set(
        handleOpenAiPresentationDeckCompletion$,
        { job, responseBody },
        signal,
      );
      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  },
);

const postFalBuiltInGenerationWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
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
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    const payload = falPayloadBody(parsed);
    if (!payload) {
      return jsonError("Invalid payload", 400);
    }
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      return new Response("OK", { status: 200 });
    }

    const status = payload.status?.toUpperCase();
    if (status === "ERROR" || status === "FAILED") {
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
      return new Response("OK", { status: 200 });
    }

    if (query.visualKey) {
      if (job.type === "presentation") {
        await set(
          handlePresentationVisualCompletion$,
          {
            job,
            visualKey: query.visualKey,
            providerBody: payload.body,
            provider: "fal",
          },
          signal,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (job.type === "image") {
      await set(
        handleFalImageCompletion$,
        { job, payload: payload.body },
        signal,
      );
      return new Response("OK", { status: 200 });
    }
    if (job.type === "video") {
      await set(
        handleFalVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  },
);

export const webhooksBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: webhookBuiltInGenerationOpenAiContract.post,
    handler: postOpenAiBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationFalContract.post,
    handler: postFalBuiltInGenerationWebhook$,
  },
];
