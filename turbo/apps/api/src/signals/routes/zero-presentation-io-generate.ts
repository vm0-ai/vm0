import { command } from "ccstate";
import { zeroPresentationIoGenerateContract } from "@vm0/api-contracts/contracts/zero-presentation-io-generate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route";
import { env } from "../../lib/env";
import {
  getMissingImagePricing,
  IMAGE_IO_MODEL,
  imagePricing$,
} from "../services/zero-image-io-generate.service";
import {
  checkPresentationCredits$,
  createOpenAiPresentationRequest,
  generatePresentationVisuals$,
  OPENAI_PRESENTATION_GENERATION_URL,
  PRESENTATION_IO_SYNC_RESPONSE_BUDGET_MS,
  parsePresentationGenerationResult,
  parsePresentationOptions,
  presentationInsufficientCredits,
  presentationInternalError,
  presentationPricing$,
  presentationServiceUnavailable,
  recordGeneratedPresentation$,
} from "../services/zero-presentation-io-generate.service";

const L = logger("ZeroPresentationIoGenerate");
const presentationBody$ = bodyResultOf(zeroPresentationIoGenerateContract.post);

const postPresentationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deadlineAtMs = now() + PRESENTATION_IO_SYNC_RESPONSE_BUDGET_MS;
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
      ? getMissingImagePricing(imagePricing, IMAGE_IO_MODEL)
      : [];
    if (options.imageCount > 0 && missingImagePricing.length > 0) {
      return presentationServiceUnavailable(
        "Presentation image generation pricing is not configured",
        "NOT_CONFIGURED",
      );
    }

    const openaiResponse = await fetch(OPENAI_PRESENTATION_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createOpenAiPresentationRequest(options)),
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
      return presentationInternalError("Presentation generation failed");
    }

    const responseBody: unknown = await openaiResponse.json();
    signal.throwIfAborted();
    const generation = parsePresentationGenerationResult(responseBody, options);
    if ("status" in generation) {
      if (generation.body.error.code === "USAGE_UNKNOWN") {
        L.error("OpenAI presentation response missing usage", {
          responseBody,
        });
      }
      return generation;
    }

    const runId =
      auth.tokenType === "zero" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    const visuals =
      options.imageCount > 0 && imagePricing
        ? await set(
            generatePresentationVisuals$,
            {
              orgId: auth.orgId,
              userId: auth.userId,
              runId,
              imagePricing,
              generation,
              options,
              deadlineAtMs,
            },
            signal,
          )
        : [];
    if ("status" in visuals) {
      return visuals;
    }

    const result = await set(
      recordGeneratedPresentation$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        pricing,
        generation,
        options,
        visuals,
      },
      signal,
    );

    return { status: 200 as const, body: result };
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
