import { command } from "ccstate";
import { zeroVoiceIoTtsContract } from "@vm0/api-contracts/contracts/zero-voice-io-tts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import {
  badRequest,
  forbidden,
  internalError,
  OPENAI_AUDIO_SPEECH_URL,
  TTS_CONTENT_TYPE,
  TTS_MAX_TEXT_LENGTH,
  TTS_RESPONSE_FORMAT,
  VOICE_IO_TTS_MODEL,
} from "../services/zero-voice-io-post.service";
import { env } from "../../lib/env";

const L = logger("ZeroVoiceIoTts");
const ttsBody$ = bodyResultOf(zeroVoiceIoTtsContract.post);

const postTtsInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();

  const enabled = isFeatureEnabled(FeatureSwitchKey.AudioOutput, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
  if (!enabled) {
    return forbidden("Audio output is not enabled");
  }

  const bodyResult = await get(ttsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const text =
    typeof bodyResult.data.text === "string" ? bodyResult.data.text : "";
  if (text.trim().length === 0) {
    return badRequest("text is required");
  }
  if (text.length > TTS_MAX_TEXT_LENGTH) {
    return badRequest(`text must be at most ${TTS_MAX_TEXT_LENGTH} characters`);
  }

  const response = await fetch(OPENAI_AUDIO_SPEECH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOICE_IO_TTS_MODEL,
      voice: "ash",
      input: text,
      response_format: TTS_RESPONSE_FORMAT,
    }),
    signal,
  });
  signal.throwIfAborted();

  if (!response.ok) {
    const errorBody = await response.text();
    signal.throwIfAborted();
    L.error("OpenAI TTS request failed", {
      status: response.status,
      body: errorBody,
    });
    return internalError("TTS generation failed");
  }

  return new Response(response.body, {
    status: 200,
    headers: { "Content-Type": TTS_CONTENT_TYPE },
  });
});

export const zeroVoiceIoTtsRoutes: readonly RouteEntry[] = [
  {
    route: zeroVoiceIoTtsContract.post,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      postTtsInner$,
    ),
  },
];
