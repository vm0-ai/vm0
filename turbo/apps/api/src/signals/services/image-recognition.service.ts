import { randomUUID } from "node:crypto";

import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
  IMAGE_RECOGNITION_MAX_TEXT_CHARS,
  imageRecognitionMimeTypeSchema,
  type ImageRecognitionRequest,
  type ImageRecognitionResponse,
} from "@okouai/api-contracts/contracts/image-recognition";
import { command } from "ccstate";

import { insufficientCredits, notConfigured, notFound } from "../../lib/error";
import type { AgentAuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  generateTextWithUsage,
  isLlmConfigured,
  OpenRouterRequestError,
  type OpenRouterContentPart,
  type OpenRouterUsage,
} from "../external/openrouter";
import { settle } from "../utils";
import {
  resolveArtifactObject$,
  type ResolvedArtifactObject,
} from "./artifact-storage.service";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import {
  checkOpenRouterUsagePricing$,
  recordOpenRouterUsage$,
} from "./openrouter-usage.service";
import { resolveProviderReferenceUrls$ } from "./provider-reference-url.service";

const IMAGE_RECOGNITION_MODEL = "xiaomi/mimo-v2.5";
const IMAGE_RECOGNITION_OPERATION = "image-recognition";
const IMAGE_RECOGNITION_MAX_TOKENS = 8192;

type RecognitionAuth = Extract<AgentAuthContext, { readonly orgId: string }>;

interface RecognitionArgs {
  readonly auth: RecognitionAuth;
  readonly body: ImageRecognitionRequest;
}

function recognitionError<Status extends number>(
  status: Status,
  code: string,
  message: string,
) {
  return {
    status,
    body: { error: { message, code } },
  } as const;
}

function providerError(error: unknown) {
  if (!(error instanceof OpenRouterRequestError)) {
    return recognitionError(
      502,
      "IMAGE_RECOGNITION_FAILED",
      "Image recognition failed to produce a usable response",
    );
  }
  if (
    error.errorType === "invalid_image" ||
    error.errorType === "image_too_small" ||
    error.errorType === "unsupported_image_format"
  ) {
    return recognitionError(
      400,
      "INVALID_IMAGE",
      "The uploaded file is not a valid PNG, JPEG, or WebP image",
    );
  }
  if (error.errorType === "image_too_large") {
    return recognitionError(
      413,
      "IMAGE_TOO_LARGE",
      "The image exceeds the recognition provider's size limit",
    );
  }
  if (
    error.errorType === "image_not_found" ||
    error.errorType === "image_download_failed"
  ) {
    return recognitionError(
      502,
      "IMAGE_UNAVAILABLE",
      "The recognition provider could not read the uploaded image",
    );
  }
  if (error.status === 429 || error.status >= 500) {
    return recognitionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Image recognition is temporarily unavailable",
    );
  }
  return recognitionError(
    502,
    "IMAGE_RECOGNITION_FAILED",
    "Image recognition failed to produce a usable response",
  );
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function hasCompleteRecognitionUsage(
  usage: OpenRouterUsage | undefined,
): boolean {
  if (usage === undefined) {
    return false;
  }
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (
    !isPositiveSafeInteger(promptTokens) ||
    !isPositiveSafeInteger(completionTokens)
  ) {
    return false;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return (
    cachedTokens === undefined ||
    (Number.isSafeInteger(cachedTokens) &&
      cachedTokens >= 0 &&
      cachedTokens <= promptTokens)
  );
}

function validateArtifact(artifact: ResolvedArtifactObject | null) {
  if (artifact === null) {
    return notFound("Uploaded image not found");
  }
  if (!imageRecognitionMimeTypeSchema.safeParse(artifact.contentType).success) {
    return recognitionError(
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      "Image must be a PNG, JPEG, or WebP file",
    );
  }
  if (artifact.size <= 0) {
    return recognitionError(400, "EMPTY_IMAGE", "Image file must not be empty");
  }
  if (artifact.size > IMAGE_RECOGNITION_MAX_FILE_BYTES) {
    return recognitionError(
      413,
      "IMAGE_TOO_LARGE",
      "Image file must be 20 MB or smaller",
    );
  }
  return artifact;
}

export const imageRecognition$ = command(
  async ({ get, set }, args: RecognitionArgs, signal: AbortSignal) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();

    const resolved = await set(
      resolveArtifactObject$,
      { userId: args.auth.userId, id: args.body.fileId },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    const artifact = validateArtifact(resolved);
    if ("status" in artifact) {
      return artifact;
    }

    if (!isLlmConfigured()) {
      return notConfigured("Image recognition is not configured");
    }
    const hasCredits = await set(
      checkBillableOperationCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: args.auth.runId,
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (!hasCredits) {
      return insufficientCredits();
    }
    const missingPricing = await set(
      checkOpenRouterUsagePricing$,
      {
        provider: IMAGE_RECOGNITION_MODEL,
        operation: IMAGE_RECOGNITION_OPERATION,
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (missingPricing.length > 0) {
      return notConfigured("Image recognition pricing is not configured");
    }

    const [providerImageUrl] = await set(
      resolveProviderReferenceUrls$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        urls: [artifact.url],
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (!providerImageUrl) {
      throw new Error("Expected a resolved image recognition URL");
    }
    const content: OpenRouterContentPart[] = [
      { type: "text", text: args.body.prompt },
      { type: "image_url", image_url: { url: providerImageUrl } },
    ];
    const operationId = randomUUID();
    const generated = await settle(
      generateTextWithUsage(
        IMAGE_RECOGNITION_MODEL,
        [{ role: "user", content }],
        IMAGE_RECOGNITION_MAX_TOKENS,
        {},
        requestSignal,
      ),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (generated.value === null) {
      return notConfigured("Image recognition is not configured");
    }
    if (generated.value.text.length > IMAGE_RECOGNITION_MAX_TEXT_CHARS) {
      return recognitionError(
        502,
        "IMAGE_RECOGNITION_FAILED",
        "Image recognition returned too much text",
      );
    }
    if (!hasCompleteRecognitionUsage(generated.value.usage)) {
      return recognitionError(
        502,
        "MISSING_PROVIDER_USAGE",
        "Image recognition did not report complete billable usage",
      );
    }

    // Provider work is complete, so a client disconnect must not skip billing.
    const settlement = await set(
      recordOpenRouterUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: args.auth.runId,
        provider: IMAGE_RECOGNITION_MODEL,
        operation: IMAGE_RECOGNITION_OPERATION,
        operationId,
        usage: generated.value.usage,
      },
      signal,
    );
    signal.throwIfAborted();
    if (settlement.kind === "no-usage") {
      return recognitionError(
        502,
        "MISSING_PROVIDER_USAGE",
        "Image recognition did not report billable usage",
      );
    }
    if (settlement.kind === "unsettled") {
      throw new Error("Failed to settle image recognition usage");
    }

    const body: ImageRecognitionResponse = {
      text: generated.value.text,
      metadata: { creditsCharged: settlement.creditsCharged },
    };
    return { status: 200 as const, body };
  },
);
