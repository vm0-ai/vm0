import {
  VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS,
  voiceIoTranscribeContract,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isStaffOrg } from "@okouai/core/staff-org";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { audioInputLifetimeQuota } from "../services/voice-io.service";
import {
  badRequest,
  getAudioDuration,
  MAX_STT_FILE_SIZE,
  MAX_STT_REQUEST_DURATION_SECONDS,
  recordSttUsage$,
  sttDailyPolicy$,
} from "../services/voice-io-post.service";
import { transcribeVoiceDraft$ } from "../services/voice-io-transcribe.service";

const ALLOWED_VOICE_DRAFT_MIME_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
] as const;

const voiceIoTranscribeEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!isStaffOrg(auth.orgId)) {
    return false;
  }
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.VoiceDraft, context);
});

function isAllowedVoiceDraftMimeType(value: string): boolean {
  return ALLOWED_VOICE_DRAFT_MIME_TYPES.some((mimeType) => {
    return mimeType === value;
  });
}

function audioFiles(formData: FormData): readonly File[] | null {
  const entries = formData.getAll("file");
  if (
    entries.length === 0 ||
    entries.some((entry) => {
      return !(entry instanceof File);
    })
  ) {
    return null;
  }
  return entries as readonly File[];
}

function lastAssistantReference(formData: FormData): string | undefined | null {
  const value = formData.get("lastAssistantMessage");
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const reference = value.trim();
  if (!reference || reference.length > VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS) {
    return null;
  }
  return reference;
}

const postVoiceIoTranscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(voiceIoTranscribeEnabled$))) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN" as const,
            message: "Voice draft transcription is not enabled",
          },
        },
      };
    }
    signal.throwIfAborted();

    const auth = get(organizationAuthContext$);
    const quota = await get(audioInputLifetimeQuota(auth.orgId, auth.userId));
    signal.throwIfAborted();
    if (!quota.allowed) {
      return {
        status: 402 as const,
        body: {
          error: {
            message:
              "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
            code: "AUDIO_INPUT_QUOTA_EXCEEDED",
          },
          quota: { count: quota.count, limit: quota.limit },
        },
      };
    }

    const formData = await get(request$).raw.formData();
    signal.throwIfAborted();
    const files = audioFiles(formData);
    if (!files) {
      return badRequest("No audio file provided");
    }
    const reference = lastAssistantReference(formData);
    if (reference === null) {
      return badRequest("Invalid last assistant message");
    }

    const totalBytes = files.reduce((total, file) => {
      return total + file.size;
    }, 0);
    if (totalBytes > MAX_STT_FILE_SIZE) {
      return badRequest("Audio files are too large (max 25 MB)");
    }
    for (const file of files) {
      const baseMimeType = file.type.split(";")[0]?.toLowerCase() ?? file.type;
      if (!isAllowedVoiceDraftMimeType(baseMimeType)) {
        return badRequest("Voice draft audio must be 16 kHz PCM WAV");
      }
    }

    const durations = await Promise.all(
      files.map(async (file) => {
        return await getAudioDuration(file);
      }),
    );
    signal.throwIfAborted();
    if (
      durations.some((duration) => {
        return duration === null || duration <= 0;
      })
    ) {
      return badRequest("Voice draft audio contains an invalid WAV file");
    }
    const durationSeconds = durations.reduce<number>((total, duration) => {
      return total + (duration ?? 0);
    }, 0);
    if (durationSeconds > MAX_STT_REQUEST_DURATION_SECONDS) {
      return badRequest(
        `Audio duration (${durationSeconds}s) exceeds maximum (${MAX_STT_REQUEST_DURATION_SECONDS}s)`,
        "AUDIO_DURATION_TOO_LONG",
      );
    }

    const policy = await set(
      sttDailyPolicy$,
      auth.orgId,
      auth.userId,
      durationSeconds,
      signal,
    );
    if ("status" in policy) {
      return policy;
    }

    const result = await set(
      transcribeVoiceDraft$,
      {
        files,
        ...(reference === undefined ? {} : { lastAssistantMessage: reference }),
      },
      signal,
    );
    if (result.status !== 200) {
      return result;
    }

    await set(
      recordSttUsage$,
      { ...policy, orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return result;
  },
);

export const voiceIoTranscribeRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoTranscribeContract.post,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      postVoiceIoTranscribe$,
    ),
  },
];
