import { command } from "ccstate";
import {
  introVideoAgentContract,
  type IntroVideoAgentGenerateRequest,
} from "@okouai/api-contracts/contracts/intro-video-agent";

import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { checkBillableOperationCredits$ } from "../services/billable-operation-admission.service";
import { readBuiltInGenerationRequestInternal } from "../services/built-in-generation.service";
import {
  getHeyGenAvatarLook,
  isHeyGenErrorResponse,
  verifyHeyGenPublicStyle,
  verifyHeyGenVideoAgentVoice,
} from "../services/heygen.service";
import {
  introVideoDisabled,
  introVideoEnabled$,
} from "../services/intro-video-access.service";
import { introVideoAgentPricing$ } from "../services/intro-video-agent-pricing.service";
import {
  createIntroVideoAgentJob$,
  introVideoAgentError,
  introVideoAgentRequestHash,
  loadIntroVideoAgentJob$,
  reconcileIntroVideoAgentJob$,
  resolveIntroVideoAgentReferences$,
  serializeIntroVideoAgentJob,
  submitIntroVideoAgentJob$,
} from "../services/intro-video-agent.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const generateBody$ = bodyResultOf(introVideoAgentContract.generate);
const statusParams$ = pathParamsOf(introVideoAgentContract.get);

const notFound = Object.freeze({
  status: 404 as const,
  body: introVideoAgentError("Intro Video generation not found", "NOT_FOUND"),
});

type IntroVideoAgentJob = Parameters<typeof serializeIntroVideoAgentJob>[0];

function isOwnedIntroVideoAgentJob(
  job: IntroVideoAgentJob | null,
  auth: { readonly orgId: string; readonly userId: string },
): job is IntroVideoAgentJob {
  return (
    job !== null &&
    job.orgId === auth.orgId &&
    job.userId === auth.userId &&
    readBuiltInGenerationRequestInternal(job.request).providerTask ===
      "intro-video-agent"
  );
}

function generationResponse(job: IntroVideoAgentJob) {
  return {
    status:
      job.status === "completed" || job.status === "failed"
        ? (200 as const)
        : (202 as const),
    body: serializeIntroVideoAgentJob(job),
  };
}

async function resolveIntroVideoAgentChoices(
  input: IntroVideoAgentGenerateRequest,
  apiKey: string,
  signal: AbortSignal,
) {
  const style = await verifyHeyGenPublicStyle(input.styleId, apiKey, signal);
  if (isHeyGenErrorResponse(style)) {
    return style;
  }
  if (!style) {
    return {
      status: 400 as const,
      body: introVideoAgentError(
        "Select a concrete style ID from the live Intro Video style catalog, including when Style is Let Okou choose.",
      ),
    };
  }
  if (input.avatarGroupId && !input.avatarId) {
    return {
      status: 400 as const,
      body: introVideoAgentError(
        "An avatar group ID is not an avatar look ID. Select a concrete avatar look.",
      ),
    };
  }
  let voiceId = input.voiceId;
  if (input.avatarId) {
    const avatar = await getHeyGenAvatarLook(input.avatarId, apiKey, signal);
    if (isHeyGenErrorResponse(avatar)) {
      return avatar;
    }
    if (
      !avatar ||
      (input.avatarGroupId && avatar.groupId !== input.avatarGroupId)
    ) {
      return {
        status: 400 as const,
        body: introVideoAgentError(
          "The selected avatar look is unavailable or does not belong to the selected group.",
        ),
      };
    }
    voiceId ??= avatar.defaultVoiceId ?? undefined;
    if (!voiceId) {
      return {
        status: 400 as const,
        body: introVideoAgentError(
          "The selected avatar has no available default voice. Select an explicit voice ID.",
        ),
      };
    }
  }
  if (voiceId) {
    const voice = await verifyHeyGenVideoAgentVoice(voiceId, apiKey, signal);
    if (isHeyGenErrorResponse(voice)) {
      return voice;
    }
    if (!voice) {
      return {
        status: 400 as const,
        body: introVideoAgentError(
          "The selected HeyGen voice is unavailable for Video Agent generation.",
        ),
      };
    }
  }
  return { voiceId };
}

const postGenerate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Intro Video Agent requires run authentication");
  }
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const parsed = await get(generateBody$);
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const input = parsed.data;
  const existing = await set(loadIntroVideoAgentJob$, input.requestId, signal);
  if (existing) {
    if (!isOwnedIntroVideoAgentJob(existing, auth)) {
      return notFound;
    }
    if (existing.request.inputHash !== introVideoAgentRequestHash(input)) {
      return {
        status: 409 as const,
        body: introVideoAgentError(
          "This request ID already belongs to different input. Resume the existing generation; do not automatically submit another paid job.",
          "REQUEST_ID_CONFLICT",
        ),
      };
    }
    return generationResponse(existing);
  }
  const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
  signal.throwIfAborted();
  if (capabilities?.videoGenerationAllowed !== true) {
    return {
      status: 402 as const,
      body: introVideoAgentError(
        "Intro Video generation requires Pro, Team, or Custom workspace access.",
        "PRO_REQUIRED",
      ),
    };
  }
  const apiKey = env("HEYGEN_API_KEY");
  if (!apiKey || !(await get(introVideoAgentPricing$))) {
    return {
      status: 503 as const,
      body: introVideoAgentError(
        "Managed HeyGen Video Agent generation and pricing must be configured.",
        "NOT_CONFIGURED",
      ),
    };
  }
  signal.throwIfAborted();
  const choices = await resolveIntroVideoAgentChoices(input, apiKey, signal);
  if ("status" in choices) {
    return choices;
  }
  const fileUrls = await set(
    resolveIntroVideoAgentReferences$,
    { userId: auth.userId, urls: input.fileUrls ?? [] },
    signal,
  );
  if ("error" in fileUrls) {
    return { status: 400 as const, body: fileUrls };
  }
  if (
    !(await set(
      checkBillableOperationCredits$,
      { orgId: auth.orgId, userId: auth.userId, runId: auth.runId },
      signal,
    ))
  ) {
    return {
      status: 402 as const,
      body: introVideoAgentError(
        "Insufficient credits. Please add credits to continue.",
        "INSUFFICIENT_CREDITS",
      ),
    };
  }
  const created = await set(
    createIntroVideoAgentJob$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      publicBrand: PUBLIC_BRAND,
      input,
      options: {
        ...input,
        ...(choices.voiceId ? { voiceId: choices.voiceId } : {}),
      },
    },
    signal,
  );
  const job = await set(loadIntroVideoAgentJob$, input.requestId, signal);
  if (!isOwnedIntroVideoAgentJob(job, auth)) {
    return notFound;
  }
  if (job.request.inputHash !== introVideoAgentRequestHash(input)) {
    return {
      status: 409 as const,
      body: introVideoAgentError(
        "This request ID already belongs to different input. Resume the existing generation.",
        "REQUEST_ID_CONFLICT",
      ),
    };
  }
  if (created) {
    await set(submitIntroVideoAgentJob$, { job, fileUrls, apiKey }, signal);
  }
  const updated = await set(loadIntroVideoAgentJob$, input.requestId, signal);
  if (!updated) {
    throw new Error("Intro Video job disappeared after submission");
  }
  return generationResponse(updated);
});

const getStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await get(introVideoEnabled$))) {
    return introVideoDisabled;
  }
  signal.throwIfAborted();
  const { generationId } = get(statusParams$);
  const job = await set(loadIntroVideoAgentJob$, generationId, signal);
  if (!isOwnedIntroVideoAgentJob(job, auth)) {
    return notFound;
  }
  await set(reconcileIntroVideoAgentJob$, generationId, signal);
  const updated = await set(loadIntroVideoAgentJob$, generationId, signal);
  if (!updated) {
    return notFound;
  }
  return { status: 200 as const, body: serializeIntroVideoAgentJob(updated) };
});

export const introVideoAgentRoutes: readonly RouteEntry[] = [
  {
    route: introVideoAgentContract.generate,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postGenerate$,
    ),
  },
  {
    route: introVideoAgentContract.get,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      getStatus$,
    ),
  },
];
