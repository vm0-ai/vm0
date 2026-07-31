import { randomUUID } from "node:crypto";

import {
  ZERO_RECOGNITION_MAX_FILE_BYTES,
  ZERO_RECOGNITION_MAX_TEXT_CHARS,
  zeroRecognitionImageMimeTypeSchema,
  type ZeroRecognitionRequest,
  type ZeroRecognitionResponse,
} from "@vm0/api-contracts/contracts/zero-recognition";
import { command } from "ccstate";

import { insufficientCredits, notConfigured, notFound } from "../../lib/error";
import type { ZeroAuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  generateTextWithUsage,
  isLlmConfigured,
  OpenRouterRequestError,
  type OpenRouterContentPart,
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

const ZERO_RECOGNITION_MODEL = "google/gemini-3.5-flash";
const ZERO_RECOGNITION_MAX_TOKENS = 8192;

type RecognitionAuth = Extract<ZeroAuthContext, { readonly orgId: string }>;

interface RecognitionArgs {
  readonly auth: RecognitionAuth;
  readonly body: ZeroRecognitionRequest;
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

function validateArtifact(artifact: ResolvedArtifactObject | null) {
  if (artifact === null) {
    return notFound("Uploaded image not found");
  }
  if (
    !zeroRecognitionImageMimeTypeSchema.safeParse(artifact.contentType).success
  ) {
    return recognitionError(
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      "Image must be a PNG, JPEG, or WebP file",
    );
  }
  if (artifact.size <= 0) {
    return recognitionError(400, "EMPTY_IMAGE", "Image file must not be empty");
  }
  if (artifact.size > ZERO_RECOGNITION_MAX_FILE_BYTES) {
    return recognitionError(
      413,
      "IMAGE_TOO_LARGE",
      "Image file must be 20 MB or smaller",
    );
  }
  return artifact;
}

export const zeroRecognition$ = command(
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
      { orgId: args.auth.orgId },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (!hasCredits) {
      return insufficientCredits();
    }
    const missingPricing = await set(
      checkOpenRouterUsagePricing$,
      { provider: ZERO_RECOGNITION_MODEL },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (missingPricing.length > 0) {
      return notConfigured("Image recognition pricing is not configured");
    }

    const content: OpenRouterContentPart[] = [
      { type: "text", text: args.body.prompt },
      { type: "image_url", image_url: { url: artifact.url } },
    ];
    const operationId = randomUUID();
    const generated = await settle(
      generateTextWithUsage(
        ZERO_RECOGNITION_MODEL,
        [{ role: "user", content }],
        ZERO_RECOGNITION_MAX_TOKENS,
        { signal: requestSignal },
      ),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (generated.value === null) {
      return notConfigured("Image recognition is not configured");
    }
    if (generated.value.text.length > ZERO_RECOGNITION_MAX_TEXT_CHARS) {
      return recognitionError(
        502,
        "IMAGE_RECOGNITION_FAILED",
        "Image recognition returned too much text",
      );
    }
    if (generated.value.usage === undefined) {
      return recognitionError(
        502,
        "MISSING_PROVIDER_USAGE",
        "Image recognition did not report billable usage",
      );
    }

    // Provider work is complete, so a client disconnect must not skip billing.
    const settlement = await set(
      recordOpenRouterUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: args.auth.runId,
        provider: ZERO_RECOGNITION_MODEL,
        operation: "image-recognition",
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

    const body: ZeroRecognitionResponse = {
      text: generated.value.text,
      metadata: { creditsCharged: settlement.creditsCharged },
    };
    return { status: 200 as const, body };
  },
);
