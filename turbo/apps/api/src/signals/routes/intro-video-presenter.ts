import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import { heyGenBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";
import {
  generateHeyGenSpeech,
  isHeyGenErrorResponse,
  listHeyGenPublicVoices,
  submitHeyGenAvatarVideo,
} from "../services/heygen.service";
import {
  checkIntroVideoPresenterCredits$,
  introVideoPresenterInsufficientCredits,
  introVideoPresenterPricing$,
  introVideoPresenterRequiresPaidPlan,
  introVideoPresenterServiceUnavailable,
  isIntroVideoPresenterErrorResponse,
  parseIntroVideoPresenterOptions,
  type IntroVideoPresenterOptions,
} from "../services/intro-video-presenter.service";
import {
  checkIntroVideoVoiceCredits$,
  introVideoVoiceInsufficientCredits,
  introVideoVoicePricing$,
  introVideoVoiceRequiresPaidPlan,
  introVideoVoiceServiceUnavailable,
  isIntroVideoVoiceErrorResponse,
  parseIntroVideoVoiceOptions,
  recordGeneratedIntroVideoVoice$,
} from "../services/intro-video-voice.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { onRejection } from "../utils";

const generateBody$ = bodyResultOf(introVideoPresenterContract.generate);
const voicesQuery$ = queryOf(introVideoPresenterContract.voices);
const voiceGenerateBody$ = bodyResultOf(
  introVideoPresenterContract.voiceGenerate,
);

const introVideoDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Intro Video is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const introVideoEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.IntroVideo, context);
});

function acceptedIntroVideoPresenterResponse(
  generationId: string,
  realtime: BuiltInGenerationRealtimeSubscription,
) {
  return {
    status: 202 as const,
    body: {
      generationId,
      type: "video" as const,
      status: "queued" as const,
      realtime,
    },
  };
}

function introVideoPresenterRequestRecord(
  options: IntroVideoPresenterOptions,
): Record<string, unknown> {
  return {
    purpose: "intro-video-presenter",
    avatarId: options.avatarId,
    audioUrl: options.audioUrl,
    ...(options.videoName ? { videoName: options.videoName } : {}),
  };
}

const submitIntroVideoPresenterJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly options: IntroVideoPresenterOptions;
    },
    signal: AbortSignal,
  ) => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      const response = introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter generation is not configured",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }

    const [audioUrl] = await set(
      resolveProviderReferenceUrls$,
      {
        orgId: args.orgId,
        userId: args.userId,
        urls: [args.options.audioUrl],
      },
      signal,
    );
    if (!audioUrl) {
      throw new Error("Expected one resolved Intro Video presenter audio URL");
    }
    const providerOptions = { ...args.options, audioUrl };
    const handle = await submitHeyGenAvatarVideo(
      providerOptions,
      {
        generationId: args.generationId,
        callbackUrl: heyGenBuiltInGenerationWebhookUrl({
          generationId: args.generationId,
        }),
      },
      apiKey,
      signal,
    );
    signal.throwIfAborted();
    if (isHeyGenErrorResponse(handle)) {
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
          provider: "heygen",
          providerJobId: handle.videoId,
          providerTask: "intro-video-presenter",
        },
      },
      signal,
    );
    return null;
  },
);

const getVoicesInner$ = command(async ({ get }, signal: AbortSignal) => {
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const apiKey = env("HEYGEN_API_KEY");
  if (!apiKey) {
    return introVideoVoiceServiceUnavailable(
      "HeyGen Intro Video voices are not configured",
    );
  }
  const query = get(voicesQuery$);
  const result = await listHeyGenPublicVoices(
    {
      token: query.token,
      pageSize: query.pageSize ?? 24,
      language: query.language,
      gender: query.gender,
    },
    apiKey,
    signal,
  );
  if (isHeyGenErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const postVoiceGenerateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error("Intro Video voice route requires run authentication");
    }
    if (!(await get(introVideoEnabled$))) {
      return introVideoDisabled;
    }
    signal.throwIfAborted();

    const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return introVideoVoiceRequiresPaidPlan();
    }

    const bodyResult = await get(voiceGenerateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const options = parseIntroVideoVoiceOptions(bodyResult.data);
    if (isIntroVideoVoiceErrorResponse(options)) {
      return options;
    }

    const hasCredits = await set(
      checkIntroVideoVoiceCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return introVideoVoiceInsufficientCredits();
    }

    const pricing = await get(introVideoVoicePricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return introVideoVoiceServiceUnavailable(
        "HeyGen Intro Video voice pricing is not configured",
      );
    }
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      return introVideoVoiceServiceUnavailable(
        "HeyGen Intro Video voices are not configured",
      );
    }

    const admission = await set(
      startRunBuiltInAdmission$,
      { runId: auth.runId, kind: "voice" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    const response = await onRejection(
      (async () => {
        const speech = await generateHeyGenSpeech(options, apiKey, signal);
        signal.throwIfAborted();
        if (isHeyGenErrorResponse(speech)) {
          await set(completeRunBuiltInAdmission$, {
            admission,
            status: "failed",
          });
          signal.throwIfAborted();
          return speech;
        }
        const body = await set(
          recordGeneratedIntroVideoVoice$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            runId: auth.runId,
            publicBrand: auth.publicBrand,
            pricing,
            options,
            speech,
          },
          signal,
        );
        await set(completeRunBuiltInAdmission$, {
          admission,
          status: "completed",
        });
        signal.throwIfAborted();
        return { status: 200 as const, body };
      })(),
      async () => {
        await set(completeRunBuiltInAdmission$, {
          admission,
          status: "failed",
        });
        signal.throwIfAborted();
      },
    );
    signal.throwIfAborted();
    return response;
  },
);

const postGenerateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error(
        "Intro Video presenter route requires run authentication",
      );
    }
    if (!(await get(introVideoEnabled$))) {
      return introVideoDisabled;
    }
    signal.throwIfAborted();

    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return introVideoPresenterRequiresPaidPlan();
    }

    const bodyResult = await get(generateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const options = parseIntroVideoPresenterOptions(bodyResult.data);
    if (isIntroVideoPresenterErrorResponse(options)) {
      return options;
    }

    const hasCredits = await set(
      checkIntroVideoPresenterCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return introVideoPresenterInsufficientCredits();
    }

    const pricing = await get(introVideoPresenterPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter pricing is not configured",
      );
    }
    if (!env("HEYGEN_API_KEY")) {
      return introVideoPresenterServiceUnavailable(
        "HeyGen Intro Video presenter generation is not configured",
      );
    }

    const generationId = randomUUID();
    const realtime = await createBuiltInGenerationRealtimeSubscription(
      auth.userId,
      generationId,
    );
    signal.throwIfAborted();
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId: auth.runId, kind: "video" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    await set(
      createBuiltInGenerationJob$,
      {
        generationId,
        type: "video",
        orgId: auth.orgId,
        userId: auth.userId,
        runId: auth.runId,
        request: builtInGenerationRequestWithInternal(
          introVideoPresenterRequestRecord(options),
          { admissionId: admission?.id, publicBrand: auth.publicBrand },
        ),
      },
      signal,
    );
    const submitError = await set(
      submitIntroVideoPresenterJob$,
      {
        generationId,
        orgId: auth.orgId,
        userId: auth.userId,
        options,
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

    return acceptedIntroVideoPresenterResponse(generationId, realtime);
  },
);

export const introVideoPresenterRoutes: readonly RouteEntry[] = [
  {
    route: introVideoPresenterContract.voices,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getVoicesInner$,
    ),
  },
  {
    route: introVideoPresenterContract.voiceGenerate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postVoiceGenerateInner$,
    ),
  },
  {
    route: introVideoPresenterContract.generate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postGenerateInner$,
    ),
  },
];
