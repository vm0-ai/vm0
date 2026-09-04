import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { updateSearchParams$ } from "../route.ts";
import type { DraftSignals, RestorableAttachment } from "./chat-draft.ts";
import { introVideoWizardSignals } from "./intro-video.ts";

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
  readonly recording: RestorableAttachment;
  readonly clicks: RestorableAttachment;
}

/**
 * The desktop sends the on-disk name, so strip any directory part before it
 * reaches the composer. A value that carries no basename is malformed input and
 * makes the whole handoff unusable rather than getting a made-up name.
 */
function filename(value: string | null): string | null {
  const basename = value?.split(/[/\\]/u).at(-1)?.trim();
  return basename || null;
}

function fileSize(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function handoffFromParams(
  params: URLSearchParams,
): DesktopRecordingHandoff | null {
  const recordingId = params.get(RECORDING_ID_PARAM);
  const recordingName = filename(params.get(RECORDING_NAME_PARAM));
  const recordingSize = fileSize(params.get(RECORDING_SIZE_PARAM));
  const clicksId = params.get(CLICKS_ID_PARAM);
  const clicksName = filename(params.get(CLICKS_NAME_PARAM));
  const clicksSize = fileSize(params.get(CLICKS_SIZE_PARAM));
  if (
    !recordingId ||
    !recordingName ||
    recordingSize === null ||
    !clicksId ||
    !clicksName ||
    clicksSize === null ||
    !params.get(USER_PARAM)
  ) {
    return null;
  }
  return {
    recording: {
      id: recordingId,
      filename: recordingName,
      contentType: "video/mp4",
      size: recordingSize,
    },
    clicks: {
      id: clicksId,
      filename: clicksName,
      contentType: "application/json",
      size: clicksSize,
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

/**
 * Address the browser can play the restored recording from.
 *
 * `restoreAttachments$` has already resolved every attachment against the file
 * API, and `fileInfo$` caches that resolution, so reading it back here costs no
 * extra request.
 */
const restoredRecordingPreviewUrl$ = command(
  async (
    { get },
    draft: DraftSignals,
    recordingId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const infos = await Promise.all(
      get(draft.attachments$).map((attachment) => {
        return get(attachment.fileInfo$);
      }),
    );
    signal.throwIfAborted();
    return (
      infos.find((info) => {
        return info?.id === recordingId;
      })?.url ?? null
    );
  },
);

export const applyDesktopRecordingHandoff$ = command(
  async (
    { set },
    draft: DraftSignals,
    params: URLSearchParams,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const handoff = handoffFromParams(params);
    if (!handoff) {
      return false;
    }

    set(draft.clear$);
    // The uploads belong to the account the desktop was signed in as. That
    // ownership is enforced by the file API, which answers 404 for another
    // account's artifact, so restoring reports the mismatch as an unavailable
    // attachment instead of a second client-side identity check.
    const removedUnavailable = await set(
      draft.restoreAttachments$,
      [handoff.recording, handoff.clicks],
      signal,
    );
    if (!removedUnavailable) {
      // Prefilled for whoever dismisses the wizard: the attachments stay on the
      // draft, so the chat composer alone is still a complete request.
      set(
        draft.setInput$,
        "Create a polished intro video from this desktop screen recording.",
      );
      // The desktop already collected the source, so the wizard opens where an
      // in-browser recording lands: reviewing the take, one step from the
      // avatar. It adopts the upload rather than the bytes, which the browser
      // never had.
      set(introVideoWizardSignals.adoptUploadedRecording$, {
        attachmentIds: [handoff.recording.id, handoff.clicks.id],
        contentType: handoff.recording.contentType,
        name: handoff.recording.filename,
        previewUrl: await set(
          restoredRecordingPreviewUrl$,
          draft,
          handoff.recording.id,
          signal,
        ),
        size: handoff.recording.size,
      });
    }
    set(updateSearchParams$, withoutHandoffParams(params));
    return true;
  },
);
