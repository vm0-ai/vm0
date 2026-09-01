import type { PersistedAttachment } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { authenticatedIdentity$ } from "../auth.ts";
import { updateSearchParams$ } from "../route.ts";
import type { DraftSignals } from "./chat-draft.ts";
import { INTRO_VIDEO_AGENT_INSTRUCTIONS } from "./intro-video-agent-instructions.ts";

const RECORDING_ID_PARAM = "intro-video-recording";
const RECORDING_NAME_PARAM = "intro-video-recording-name";
const RECORDING_SIZE_PARAM = "intro-video-recording-size";
const CLICKS_ID_PARAM = "intro-video-clicks";
const CLICKS_NAME_PARAM = "intro-video-clicks-name";
const CLICKS_SIZE_PARAM = "intro-video-clicks-size";
const USER_PARAM = "intro-video-user";

export const desktopRecordingHandoffParamNames = [
  RECORDING_ID_PARAM,
  RECORDING_NAME_PARAM,
  RECORDING_SIZE_PARAM,
  CLICKS_ID_PARAM,
  CLICKS_NAME_PARAM,
  CLICKS_SIZE_PARAM,
  USER_PARAM,
] as const;

interface DesktopRecordingHandoff {
  readonly userId: string;
  readonly recording: PersistedAttachment;
  readonly clicks: PersistedAttachment;
}

function filename(value: string | null, fallback: string): string {
  const basename = value?.split(/[/\\]/u).at(-1)?.trim();
  return basename || fallback;
}

function fileSize(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function handoffFromParams(
  params: URLSearchParams,
): DesktopRecordingHandoff | null {
  const recordingId = params.get(RECORDING_ID_PARAM);
  const clicksId = params.get(CLICKS_ID_PARAM);
  const userId = params.get(USER_PARAM);
  if (!recordingId || !clicksId || !userId) {
    return null;
  }
  return {
    userId,
    recording: {
      id: recordingId,
      url: "",
      filename: filename(
        params.get(RECORDING_NAME_PARAM),
        "Desktop screen recording.mp4",
      ),
      contentType: "video/mp4",
      size: fileSize(params.get(RECORDING_SIZE_PARAM)),
    },
    clicks: {
      id: clicksId,
      url: "",
      filename: filename(
        params.get(CLICKS_NAME_PARAM),
        "Desktop screen recording.clicks.json",
      ),
      contentType: "application/json",
      size: fileSize(params.get(CLICKS_SIZE_PARAM)),
    },
  };
}

export function hasDesktopRecordingHandoff(params: URLSearchParams): boolean {
  return handoffFromParams(params) !== null;
}

export function desktopRecordingHandoffFeatureEnabled(
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  return (
    (switches[FeatureSwitchKey.IntroVideo] ?? false) &&
    (switches[FeatureSwitchKey.DesktopScreenRecording] ?? false)
  );
}

function withoutHandoffParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of desktopRecordingHandoffParamNames) {
    next.delete(name);
  }
  return next;
}

export const applyDesktopRecordingHandoff$ = command(
  async (
    { get, set },
    draft: DraftSignals,
    params: URLSearchParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const handoff = handoffFromParams(params);
    if (!handoff) {
      return false;
    }

    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    if (identity.userId !== handoff.userId) {
      throw new Error(
        "The desktop recording belongs to a different signed-in account",
      );
    }

    set(draft.clear$);
    const removedUnavailable = await set(
      draft.restoreAttachments$,
      [handoff.recording, handoff.clicks],
      signal,
    );
    if (!removedUnavailable) {
      set(draft.setAgentInstructions$, INTRO_VIDEO_AGENT_INSTRUCTIONS);
      set(
        draft.setInput$,
        "Create a polished intro video from this desktop screen recording.",
      );
    }
    set(updateSearchParams$, withoutHandoffParams(params));
    return true;
  },
);
