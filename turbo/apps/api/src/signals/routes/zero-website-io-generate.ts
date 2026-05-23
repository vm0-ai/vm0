import { randomUUID } from "node:crypto";

import { command, type Computed } from "ccstate";
import { zeroWebsiteIoGenerateContract } from "@vm0/api-contracts/contracts/zero-website-io-generate";
import type { ZeroBuiltInGenerationRealtimeSubscription } from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import type { RouteEntry } from "../route";
import { settle } from "../utils";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  getMissingImagePricing,
  imagePricing$,
  type ImagePricing,
} from "../services/zero-image-io-generate.service";
import {
  builtInGenerationRequestWithInternal,
  completeBuiltInGenerationJob$,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
} from "../services/zero-built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/zero-run-built-in-admission.service";
import {
  checkWebsiteCredits$,
  generateWebsite$,
  parseWebsiteOptions,
  type WebsitePricing,
  type WebsiteOptions,
  websiteInsufficientCredits,
  websitePricing$,
  websiteServiceUnavailable,
} from "../services/zero-website-io-generate.service";

interface WebsiteJobArgs {
  readonly generationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly admission: RunBuiltInAdmission | null;
  readonly options: WebsiteOptions;
  readonly pricing: WebsitePricing;
  readonly imagePricing: ImagePricing;
}

type WebsiteJobStatus = "completed" | "failed";

const hostedSitesDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Hosted sites are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const websiteBody$ = bodyResultOf(zeroWebsiteIoGenerateContract.post);

function websiteRequestRecord(
  options: WebsiteOptions,
): Record<string, unknown> {
  return {
    prompt: options.prompt,
    template: options.template,
    imageCount: options.imageCount,
    imageModel: options.imageModel,
    ...(options.audience ? { audience: options.audience } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
}

function acceptedWebsiteResponse(
  generationId: string,
  realtime: ZeroBuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "website" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

async function hostedSitesEnabled(
  get: <T>(computed: Computed<T>) => T,
  auth: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.HostedSites, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
}

const runWebsiteGenerationJob$ = command(
  async (
    { set },
    args: WebsiteJobArgs,
    signal: AbortSignal,
  ): Promise<WebsiteJobStatus> => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);

    const result = await set(
      generateWebsite$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        options: args.options,
        pricing: args.pricing,
        imagePricing: args.imagePricing,
        generationId: args.generationId,
      },
      signal,
    );
    if ("status" in result) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: result.body.error },
        signal,
      );
      return "failed";
    }

    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.generationId, result },
      signal,
    );
    return "completed";
  },
);

const runWebsiteGenerationJobSafely$ = command(
  async ({ set }, args: WebsiteJobArgs, signal: AbortSignal): Promise<void> => {
    const result = await settle(set(runWebsiteGenerationJob$, args, signal));
    signal.throwIfAborted();
    const admissionStatus: WebsiteJobStatus = result.ok
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

    await set(
      failBuiltInGenerationJob$,
      {
        generationId: args.generationId,
        error: {
          message: "Website generation failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      signal,
    );
  },
);

const postWebsiteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await hostedSitesEnabled(get, auth);
  signal.throwIfAborted();
  if (!enabled) {
    return hostedSitesDisabled;
  }

  const bodyResult = await get(websiteBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const options = parseWebsiteOptions(bodyResult.data);
  if ("status" in options) {
    return options;
  }

  const hasCredits = await set(
    checkWebsiteCredits$,
    { orgId: auth.orgId },
    signal,
  );
  if (!hasCredits) {
    return websiteInsufficientCredits();
  }

  const pricing = await get(websitePricing$);
  signal.throwIfAborted();
  if (!pricing) {
    return websiteServiceUnavailable(
      "Website generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const imagePricing = options.imageCount > 0 ? await get(imagePricing$) : null;
  signal.throwIfAborted();
  const missingImagePricing = imagePricing
    ? getMissingImagePricing(imagePricing, options.imageModel)
    : [];
  if (options.imageCount > 0 && missingImagePricing.length > 0) {
    return websiteServiceUnavailable(
      "Website image generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  if (options.imageCount > 0 && imagePricing) {
    const generationId = randomUUID();
    const realtime = await createBuiltInGenerationRealtimeSubscription(
      auth.userId,
      generationId,
    );
    signal.throwIfAborted();
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId, kind: "website" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    await set(
      createBuiltInGenerationJob$,
      {
        generationId,
        type: "website",
        orgId: auth.orgId,
        userId: auth.userId,
        runId,
        request: builtInGenerationRequestWithInternal(
          websiteRequestRecord(options),
          { admissionId: admission?.id },
        ),
      },
      signal,
    );
    waitUntil(
      set(
        runWebsiteGenerationJobSafely$,
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

    return acceptedWebsiteResponse(generationId, realtime);
  }

  const result = await set(
    generateWebsite$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      options,
      pricing,
      imagePricing: null,
    },
    signal,
  );
  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

export const zeroWebsiteIoGenerateRoutes: readonly RouteEntry[] = [
  {
    route: zeroWebsiteIoGenerateContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "host:write",
      },
      postWebsiteInner$,
    ),
  },
];
