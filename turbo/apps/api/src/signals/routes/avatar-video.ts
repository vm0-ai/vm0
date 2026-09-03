import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import type { BuiltInGenerationRealtimeSubscription } from "@okouai/api-contracts/contracts/built-in-generation";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { createBuiltInGenerationRealtimeSubscription } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  avatarVideoInsufficientCredits,
  avatarVideoRequiresPaidPlan,
  avatarVideoServiceUnavailable,
  checkAvatarVideoCredits$,
  heyGenAvatarVideoPricing$,
  isAvatarVideoErrorResponse,
  joggAiAvatarVideoPricing$,
  listJoggAiPublicAvatars,
  listJoggAiPublicVoices,
  parseAvatarVideoOptions,
  submitJoggAiAvatarVideo,
  type AvatarVideoOptions,
} from "../services/avatar-video.service";
import {
  isHeyGenErrorResponse,
  submitHeyGenAvatarVideo,
} from "../services/heygen.service";
import {
  builtInGenerationRequestWithInternal,
  createBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
} from "../services/built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { resolveProviderReferenceUrls$ } from "../services/provider-reference-url.service";
import { heyGenBuiltInGenerationWebhookUrl } from "../services/built-in-generation-provider-webhooks.service";

const generateBody$ = bodyResultOf(avatarVideoContract.generate);
const avatarsQuery$ = queryOf(avatarVideoContract.avatars);
const voicesQuery$ = queryOf(avatarVideoContract.voices);

function avatarVideoRequestRecord(
  options: AvatarVideoOptions,
): Record<string, unknown> {
  return {
    ...(options.provider === "heygen"
      ? { avatarProvider: options.provider }
      : {}),
    avatarId: options.avatarId,
    ...(options.provider === "joggai" ? { voiceId: options.voiceId } : {}),
    ...(options.script ? { script: options.script } : {}),
    ...(options.audioUrl ? { audioUrl: options.audioUrl } : {}),
    aspectRatio: options.aspectRatio,
    screenStyle: options.screenStyle,
    caption: options.caption,
    ...(options.videoName ? { videoName: options.videoName } : {}),
  };
}

function acceptedAvatarVideoResponse(
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

const submitAvatarVideoJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly options: AvatarVideoOptions;
    },
    signal: AbortSignal,
  ) => {
    await set(markBuiltInGenerationRunning$, args.generationId, signal);
    const apiKey =
      args.options.provider === "heygen"
        ? env("HEYGEN_API_KEY")
        : env("JOGGAI_API_KEY");
    if (!apiKey) {
      const response = avatarVideoServiceUnavailable(
        args.options.provider === "heygen"
          ? "HeyGen avatar video generation is not configured"
          : "JoggAI avatar video generation is not configured",
      );
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.generationId, error: response.body.error },
        signal,
      );
      return response;
    }

    let providerOptions = args.options;
    if (args.options.audioUrl) {
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
        throw new Error("Expected one resolved avatar audio URL");
      }
      providerOptions = { ...args.options, audioUrl };
    }
    const handle =
      providerOptions.provider === "heygen"
        ? await submitHeyGenAvatarVideo(
            providerOptions,
            {
              generationId: args.generationId,
              callbackUrl: heyGenBuiltInGenerationWebhookUrl({
                generationId: args.generationId,
              }),
            },
            apiKey,
            signal,
          )
        : await submitJoggAiAvatarVideo(providerOptions, apiKey, signal);
    signal.throwIfAborted();
    if (isAvatarVideoErrorResponse(handle) || isHeyGenErrorResponse(handle)) {
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
          provider: providerOptions.provider,
          providerJobId: handle.videoId,
          providerTask: "avatar-video",
        },
      },
      signal,
    );
    return null;
  },
);

const postGenerateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return avatarVideoRequiresPaidPlan();
    }

    const bodyResult = await get(generateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const options = parseAvatarVideoOptions(bodyResult.data);
    if (isAvatarVideoErrorResponse(options)) {
      return options;
    }

    const hasCredits = await set(
      checkAvatarVideoCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    if (!hasCredits) {
      return avatarVideoInsufficientCredits();
    }

    const pricing = await get(
      options.provider === "heygen"
        ? heyGenAvatarVideoPricing$
        : joggAiAvatarVideoPricing$,
    );
    signal.throwIfAborted();
    if (!pricing) {
      return avatarVideoServiceUnavailable(
        options.provider === "heygen"
          ? "HeyGen avatar video pricing is not configured"
          : "JoggAI avatar video pricing is not configured",
      );
    }
    const providerApiKey =
      options.provider === "heygen"
        ? env("HEYGEN_API_KEY")
        : env("JOGGAI_API_KEY");
    if (!providerApiKey) {
      return avatarVideoServiceUnavailable(
        options.provider === "heygen"
          ? "HeyGen avatar video generation is not configured"
          : "JoggAI avatar video generation is not configured",
      );
    }

    const generationId = randomUUID();
    const realtime = await createBuiltInGenerationRealtimeSubscription(
      auth.userId,
      generationId,
    );
    signal.throwIfAborted();
    const runId =
      auth.tokenType === "agent" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    const publicBrand =
      auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId, kind: "video" },
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
        runId,
        request: builtInGenerationRequestWithInternal(
          avatarVideoRequestRecord(options),
          { admissionId: admission?.id, publicBrand },
        ),
      },
      signal,
    );
    const submitError = await set(
      submitAvatarVideoJob$,
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

    return acceptedAvatarVideoResponse(generationId, realtime);
  },
);

const getAvatarsInner$ = command(async ({ get }, signal: AbortSignal) => {
  const apiKey = env("JOGGAI_API_KEY");
  if (!apiKey) {
    return avatarVideoServiceUnavailable(
      "JoggAI avatar video generation is not configured",
    );
  }
  const result = await listJoggAiPublicAvatars(
    get(avatarsQuery$),
    apiKey,
    signal,
  );
  if (isAvatarVideoErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

const getVoicesInner$ = command(async ({ get }, signal: AbortSignal) => {
  const apiKey = env("JOGGAI_API_KEY");
  if (!apiKey) {
    return avatarVideoServiceUnavailable(
      "JoggAI avatar video generation is not configured",
    );
  }
  const result = await listJoggAiPublicVoices(
    get(voicesQuery$),
    apiKey,
    signal,
  );
  if (isAvatarVideoErrorResponse(result)) {
    return result;
  }
  return { status: 200 as const, body: result };
});

export const avatarVideoRoutes: readonly RouteEntry[] = [
  {
    route: avatarVideoContract.generate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      postGenerateInner$,
    ),
  },
  {
    route: avatarVideoContract.avatars,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getAvatarsInner$,
    ),
  },
  {
    route: avatarVideoContract.voices,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getVoicesInner$,
    ),
  },
];
