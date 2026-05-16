import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroPresentationIoGenerateContract } from "@vm0/api-contracts/contracts/zero-presentation-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import {
  getMissingImagePricing,
  imagePricing$,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import { settle } from "../utils";
import {
  checkPresentationCredits$,
  createOpenAiPresentationRequest,
  generatePresentationVisuals$,
  OPENAI_PRESENTATION_GENERATION_URL,
  parsePresentationGenerationResult,
  parsePresentationOptions,
  presentationInsufficientCredits,
  type PresentationOptions,
  type PresentationPricing,
  presentationPricing$,
  presentationServiceUnavailable,
  recordGeneratedPresentation$,
} from "../services/zero-presentation-io-generate.service";
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

const L = logger("ZeroPresentationIoGenerate");
const presentationBody$ = bodyResultOf(zeroPresentationIoGenerateContract.post);

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

interface PresentationJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: PresentationOptions;
  readonly pricing: PresentationPricing;
  readonly imagePricing: ImagePricing | null;
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

function presentationRequestRecord(
  options: PresentationOptions,
): Record<string, unknown> {
  return {
    prompt: options.prompt,
    style: options.style,
    slideCount: options.slideCount,
    imageCount: options.imageCount,
    theme: options.theme,
    ...(options.audience ? { audience: options.audience } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}

const runPresentationGenerationJob$ = command(
  async (
    { set },
    args: PresentationJobArgs,
    signal: AbortSignal,
  ): Promise<AdmissionCompletionStatus> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const openaiResponse = await fetch(OPENAI_PRESENTATION_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createOpenAiPresentationRequest(args.options)),
      signal,
    });
    signal.throwIfAborted();

    if (!openaiResponse.ok) {
      const errorBody = await openaiResponse.text();
      signal.throwIfAborted();
      L.error("OpenAI presentation request failed", {
        status: openaiResponse.status,
        body: errorBody,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.generationId,
          error: {
            message: "Presentation generation failed",
            code: "INTERNAL_SERVER_ERROR",
          },
        },
        signal,
      );
      return "failed";
    }

    const responseBody: unknown = await openaiResponse.json();
    signal.throwIfAborted();
    const generation = parsePresentationGenerationResult(
      responseBody,
      args.options,
    );
    if (isErrorResponse(generation)) {
      if (generation.body.error.code === "USAGE_UNKNOWN") {
        L.error("OpenAI presentation response missing usage", {
          responseBody,
        });
      }
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: generation.body.error },
        signal,
      );
      return "failed";
    }

    const activeBeforeVisuals = await set(
      refreshActiveBuiltInGenerationJob$,
      { generationId: args.generationId, type: "presentation" },
      signal,
    );
    if (!activeBeforeVisuals) {
      return "failed";
    }

    const visuals =
      args.options.imageCount > 0 && args.imagePricing
        ? await set(
            generatePresentationVisuals$,
            {
              orgId: args.orgId,
              userId: args.userId,
              runId: args.runId,
              imagePricing: args.imagePricing,
              generation,
              options: args.options,
              generationId: args.generationId,
            },
            signal,
          )
        : [];
    if (isErrorResponse(visuals)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: visuals.body.error },
        signal,
      );
      return "failed";
    }

    const activeBeforeRecord = await set(
      refreshActiveBuiltInGenerationJob$,
      { generationId: args.generationId, type: "presentation" },
      signal,
    );
    if (!activeBeforeRecord) {
      return "failed";
    }

    const result = await set(
      recordGeneratedPresentation$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        pricing: args.pricing,
        generation,
        options: args.options,
        visuals,
        usageIdempotency: {
          generationId: args.generationId,
          scope: "presentation-text",
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

const runPresentationGenerationJobSafely$ = command(
  async (
    { set },
    args: PresentationJobArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await settle(
      set(runPresentationGenerationJob$, args, signal),
    );
    signal.throwIfAborted();
    const admissionStatus: AdmissionCompletionStatus = result.ok
      ? result.value
      : "failed";
    await set(completeRunBuiltInAdmission$, {
      admission: args.admission,
      status: admissionStatus,
    });
    signal.throwIfAborted();
    if (result.ok) {
      return;
    }

    L.error("Built-in presentation generation job failed", result.error);
    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Presentation generation failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      signal,
    );
  },
);

const postPresentationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(presentationBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const options = parsePresentationOptions(bodyResult.data);
    if ("status" in options) {
      return options;
    }

    const hasCredits = await set(
      checkPresentationCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return presentationInsufficientCredits();
    }

    const pricing = await get(presentationPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return presentationServiceUnavailable(
        "Presentation generation pricing is not configured",
        "NOT_CONFIGURED",
      );
    }

    const imagePricing =
      options.imageCount > 0 ? await get(imagePricing$) : null;
    signal.throwIfAborted();
    const missingImagePricing = imagePricing
      ? getMissingImagePricing(imagePricing, options.imageModel)
      : [];
    if (options.imageCount > 0 && missingImagePricing.length > 0) {
      return presentationServiceUnavailable(
        "Presentation image generation pricing is not configured",
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
      { runId, kind: "presentation" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    await set(
      createBuiltInGenerationJob$,
      {
        generationId,
        type: "presentation",
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        request: presentationRequestRecord(options),
      },
      signal,
    );
    waitUntil(
      set(
        runPresentationGenerationJobSafely$,
        {
          generationId,
          orgId: auth.orgId,
          userId: auth.userId,
          runId,
          admission,
          options,
          pricing,
          imagePricing,
        },
        signal,
      ),
    );

    return {
      status: 202 as const,
      body: {
        generationId,
        type: "presentation" as const,
        status: "queued" as const,
        realtime,
      },
    };
  },
);

export const zeroPresentationIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: zeroPresentationIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postPresentationInner$,
    ),
  },
];
