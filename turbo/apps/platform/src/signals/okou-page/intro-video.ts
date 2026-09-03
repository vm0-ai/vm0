import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import { command, computed, state, type Command, type State } from "ccstate";

import { i18n } from "../../i18n/index.ts";
import { now } from "../../lib/time.ts";
import {
  deleteIntroVideoDraft,
  readIntroVideoDraft,
  saveIntroVideoDraft,
  type IntroVideoDraftRecord,
  type IntroVideoSourceKind,
} from "../external/intro-video-draft-store.ts";
import type { ComposerSignals } from "./composer-signals.ts";
import { introVideoAgentInstructions } from "./intro-video-agent-instructions.ts";
import { settle } from "../utils.ts";

export type IntroVideoWizardStep =
  | "avatar"
  | "desktop-record"
  | "review"
  | "source"
  | "source-review"
  | "voice";

export type IntroVideoWizardError = "send-failed" | "upload-failed";

interface IntroVideoSourceFacts {
  readonly contentType: string;
  readonly durationSeconds: number | null;
  readonly kind: IntroVideoSourceKind;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

/**
 * A source this browser still holds the bytes for. It is kept in the local
 * draft store so a reload can restore it, and uploaded when the wizard submits.
 */
interface LocalIntroVideoSource extends IntroVideoSourceFacts {
  readonly blob: Blob;
  readonly origin: "local";
}

/**
 * A source that was already stored before the wizard saw it. The desktop
 * recorder uploads the recording and its click track and only then hands the
 * browser a link, so there are no local bytes to persist, to upload again at
 * submit, or to hand back when sending fails.
 */
interface UploadedIntroVideoSource extends IntroVideoSourceFacts {
  readonly origin: "uploaded";
}

export type IntroVideoSource = LocalIntroVideoSource | UploadedIntroVideoSource;

/** The kinds a file dialog can produce. Only the desktop hands over a video. */
type LocalIntroVideoSourceKind = "file" | "presentation";

/**
 * Metadata for an already-uploaded recording the wizard adopts as its source.
 *
 * `previewUrl` is resolved by the caller against the owning file API, so it is
 * null when that account cannot read the artifact.
 */
interface AdoptedIntroVideoRecording {
  readonly attachmentIds: readonly string[];
  readonly contentType: string;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

export type IntroVideoVoiceSelection =
  | { readonly kind: "catalog"; readonly voice: AvatarVideoVoice }
  | { readonly kind: "none" }
  | { readonly kind: "original" };

export type IntroVideoPlacement = "left" | "overlay" | "right";

const PRESENTATION_EXTENSIONS = ["html", "pdf", "ppt", "pptx"] as const;
/**
 * Aspect ratio reported to the agent for the raw avatar take.
 *
 * The wizard no longer asks for one: the take is composited by HyperFrames,
 * which reframes it and decides the delivered aspect ratio. The value is still
 * reported because it is what the avatar-video request is generated with.
 */
export const INTRO_VIDEO_ASPECT_RATIO_LABEL = "16:9";

function extensionForFilename(filename: string): string {
  return filename.split(".").pop()?.toLocaleLowerCase() ?? "";
}

/**
 * Whether a file may enter through the slide deck card.
 *
 * The extension is all this can check, so it decides which entry accepts the
 * file, never whether the deck really holds slides. That is the agent's first
 * job once it can open the attachment.
 */
export function isIntroVideoPresentation(file: Pick<File, "name">): boolean {
  const extension = extensionForFilename(file.name);
  return PRESENTATION_EXTENSIONS.some((candidate) => {
    return candidate === extension;
  });
}

function sourceFromDraft(draft: IntroVideoDraftRecord): LocalIntroVideoSource {
  return {
    blob: draft.blob,
    contentType: draft.contentType,
    durationSeconds: draft.durationSeconds,
    kind: draft.kind,
    name: draft.name,
    origin: "local",
    previewUrl: draft.kind === "video" ? URL.createObjectURL(draft.blob) : null,
    size: draft.blob.size,
  };
}

function draftFromSource(source: LocalIntroVideoSource): IntroVideoDraftRecord {
  return {
    blob: source.blob,
    contentType: source.contentType,
    createdAt: now(),
    durationSeconds: source.durationSeconds,
    kind: source.kind,
    name: source.name,
  };
}

function releasePreviewUrl(source: IntroVideoSource | null): void {
  // Only a local source owns its preview URL. An uploaded source previews from
  // a signed address the file API handed out, which is not ours to revoke.
  if (source?.origin === "local" && source.previewUrl) {
    URL.revokeObjectURL(source.previewUrl);
  }
}

function sourceFile(source: LocalIntroVideoSource): File {
  return new File([source.blob], source.name, {
    type: source.contentType,
    lastModified: now(),
  });
}

function voiceSelectionLabel(selection: IntroVideoVoiceSelection | null) {
  switch (selection?.kind) {
    case "catalog": {
      return `${selection.voice.name} (${selection.voice.id})`;
    }
    case "original": {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.original;
      });
    }
    case "none": {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    default: {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
  }
}

function buildIntroVideoPrompt(args: {
  readonly avatar: AvatarVideoAvatar | null;
  readonly instructions: string;
  readonly placement: IntroVideoPlacement;
  readonly source: IntroVideoSource;
  readonly voice: IntroVideoVoiceSelection | null;
}): string {
  const avatar = args.avatar
    ? `${args.avatar.name} (${args.avatar.id})`
    : "No avatar";
  const placementDescription: Record<IntroVideoPlacement, string> = {
    left: "Presenter on the left, slide on the right",
    overlay: "Presenter over the slide, anchored to the bottom right",
    right: "Presenter on the right, slide on the left",
  };
  const instructions = args.instructions.trim();
  return [
    "Create a polished video from the attached source.",
    "Do not add an opening or ending unless the user explicitly requests them.",
    "",
    "Configuration:",
    `- Source: ${args.source.name}`,
    `- Source type: ${args.source.kind}`,
    `- Aspect ratio: ${INTRO_VIDEO_ASPECT_RATIO_LABEL}`,
    `- Avatar: ${avatar}`,
    `- Voice: ${voiceSelectionLabel(args.voice)}`,
    ...(args.avatar?.coverUrl
      ? [`- Avatar cutout (transparent still): ${args.avatar.coverUrl}`]
      : []),
    ...(args.avatar
      ? [
          "- Avatar background: transparent WebM (JoggAI screen_style 3, which requires captions off)",
          ...(args.source.kind === "presentation"
            ? [
                `- Presenter placement: ${placementDescription[args.placement]}`,
                "- Presenter scale: scale the cutout proportionally to 14% of the frame width and align its bottom edge with the slide's bottom edge, for every presenter and every page",
              ]
            : []),
        ]
      : []),
    ...(instructions ? ["", "Editing direction:", instructions] : []),
  ].join("\n");
}

interface IntroVideoInternalState {
  /**
   * Uploads the wizard adopted from a desktop handoff, which are already
   * attached to the composer. Remembered so replacing the source can take them
   * back off the draft instead of sending a stale recording beside the new one.
   */
  readonly adoptedAttachmentIds$: State<readonly string[]>;
  readonly avatar$: State<AvatarVideoAvatar | null>;
  readonly busy$: State<boolean>;
  readonly draftDiscarded$: State<boolean>;
  readonly error$: State<IntroVideoWizardError | null>;
  readonly instructions$: State<string>;
  readonly open$: State<boolean>;
  readonly placement$: State<IntroVideoPlacement>;
  readonly source$: State<IntroVideoSource | null>;
  readonly sourceUploaded$: State<boolean>;
  readonly step$: State<IntroVideoWizardStep>;
  readonly voice$: State<IntroVideoVoiceSelection | null>;
}

function createIntroVideoInternalState(): IntroVideoInternalState {
  return {
    adoptedAttachmentIds$: state<readonly string[]>([]),
    avatar$: state<AvatarVideoAvatar | null>(null),
    busy$: state(false),
    draftDiscarded$: state(false),
    error$: state<IntroVideoWizardError | null>(null),
    instructions$: state(""),
    open$: state(false),
    placement$: state<IntroVideoPlacement>("left"),
    source$: state<IntroVideoSource | null>(null),
    sourceUploaded$: state(false),
    step$: state<IntroVideoWizardStep>("source"),
    voice$: state<IntroVideoVoiceSelection | null>(null),
  };
}

function exposeState<T>(signal: State<T>) {
  return computed((get) => {
    return get(signal);
  });
}

function createIntroVideoSelectors(internal: IntroVideoInternalState) {
  return {
    avatar$: exposeState(internal.avatar$),
    busy$: exposeState(internal.busy$),
    error$: exposeState(internal.error$),
    instructions$: exposeState(internal.instructions$),
    open$: exposeState(internal.open$),
    placement$: exposeState(internal.placement$),
    source$: exposeState(internal.source$),
    step$: exposeState(internal.step$),
    voice$: exposeState(internal.voice$),
  };
}

function sourceFromFile(
  file: File,
  kind: LocalIntroVideoSourceKind,
): LocalIntroVideoSource {
  return {
    blob: file,
    contentType: file.type || "application/octet-stream",
    durationSeconds: null,
    kind,
    name: file.name,
    origin: "local",
    previewUrl: null,
    size: file.size,
  };
}

/**
 * Where the wizard lands once it holds a source.
 *
 * A deck the user just picked in the file dialog is already what they chose, so
 * it goes straight to the presenter. A desktop take is the one source the
 * browser never saw being made, so it still gets a look before continuing.
 */
function stepAfterSource(source: IntroVideoSource): IntroVideoWizardStep {
  return source.origin === "uploaded" ? "source-review" : "avatar";
}

/**
 * The first-stage step for a given source, which is where "Back" from the
 * presenter and the header's Source tab both lead.
 *
 * A deck has no review page of its own, so its first stage is the empty source
 * step — reaching it therefore discards the deck, which is what
 * `returnToSourceStep$` exists for.
 */
export function introVideoSourceStep(
  source: IntroVideoSource | null,
): IntroVideoWizardStep {
  return source?.origin === "uploaded" ? "source-review" : "source";
}

/**
 * Return the wizard to a closed, empty source step.
 *
 * Closing the dialog and finishing a submission both discard the whole draft,
 * so the field list lives here rather than being repeated by each caller and
 * drifting apart as the wizard gains state.
 */
function createResetWizardDraftCommand(internal: IntroVideoInternalState) {
  return command(({ set }): void => {
    set(internal.source$, null);
    set(internal.sourceUploaded$, false);
    set(internal.avatar$, null);
    set(internal.voice$, null);
    set(internal.placement$, "left");
    set(internal.instructions$, "");
    set(internal.step$, "source");
    set(internal.busy$, false);
    set(internal.open$, false);
  });
}

/**
 * Takes the adopted uploads back off the composer draft.
 *
 * The handoff attaches the recording and its click track so the wizard has
 * nothing left to upload. Once the user picks a different source those files
 * are no longer part of the request, and leaving them attached would send the
 * agent two competing recordings.
 */
function createDiscardAdoptedAttachmentsCommand(
  internal: IntroVideoInternalState,
) {
  return command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<void> => {
      const adopted = get(internal.adoptedAttachmentIds$);
      if (adopted.length === 0) {
        return;
      }
      set(internal.adoptedAttachmentIds$, []);
      const resolved = await Promise.all(
        get(composer.draft.attachments$).map(async (attachment) => {
          return { attachment, info: await get(attachment.fileInfo$) };
        }),
      );
      signal.throwIfAborted();
      for (const { attachment, info } of resolved) {
        if (info && adopted.includes(info.id)) {
          set(composer.draft.removeAttachment$, attachment);
        }
      }
    },
  );
}

/**
 * Open the wizard on a clean step.
 */
function createOpenWizardCommand(internal: IntroVideoInternalState) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(internal.avatar$, null);
    set(internal.busy$, false);
    set(internal.error$, null);
    set(internal.instructions$, "");
    set(internal.sourceUploaded$, false);
    set(internal.placement$, "left");
    set(internal.voice$, null);
    const source = get(internal.source$);
    set(internal.step$, source ? stepAfterSource(source) : "source");
    // Navigating away only hides the wizard; it deliberately does not run
    // closeWizard$. Dismissing the dialog is "discard this", while leaving the
    // page is "come back to it", so the source survives a route change and the
    // user keeps an upload they never asked to throw away.
    signal.addEventListener(
      "abort",
      () => {
        set(internal.open$, false);
      },
      { once: true },
    );
    set(internal.open$, true);
    if (source) {
      return;
    }
    if (get(internal.draftDiscarded$)) {
      // The user closed the wizard, so the stored draft is dead. Clearing it
      // here keeps closeWizard$ synchronous for the dialog callback.
      set(internal.draftDiscarded$, false);
      await settle(deleteIntroVideoDraft(), signal);
      return;
    }
    const restored = await settle(readIntroVideoDraft(), signal);
    if (!restored.ok || !restored.value) {
      return;
    }
    const restoredSource = sourceFromDraft(restored.value);
    set(internal.source$, restoredSource);
    set(internal.step$, stepAfterSource(restoredSource));
  });
}

function createSourceCommands(
  internal: IntroVideoInternalState,
  resetWizardDraft$: Command<void, []>,
) {
  const openWizard$ = createOpenWizardCommand(internal);
  // Closing discards the wizard: the next open starts from an empty source
  // step. openWizard$ drops the stored draft rather than resuming it, so this
  // stays synchronous and the dialog callback needs no signal.
  const closeWizard$ = command(({ get, set }) => {
    releasePreviewUrl(get(internal.source$));
    set(resetWizardDraft$);
    set(internal.error$, null);
    set(internal.draftDiscarded$, true);
  });
  const setStep$ = command(
    ({ get, set }, nextStep: IntroVideoWizardStep): void => {
      const sourceRequired =
        nextStep !== "source" && nextStep !== "desktop-record";
      if (sourceRequired && !get(internal.source$)) {
        return;
      }
      set(internal.error$, null);
      set(internal.step$, nextStep);
    },
  );
  /**
   * Go back to the first step, dropping a deck on the way.
   *
   * A deck has no review page to step back to, so leaving the presenter is the
   * user saying they picked the wrong file. Keeping it would silently reuse a
   * source they already walked away from.
   *
   * A desktop take survives instead. The browser never held its bytes, the
   * handoff params are already stripped from the URL, and the draft store has
   * nothing to restore, so dropping it here would cost a recording that only
   * another desktop session can replace. Its review page stays reachable from
   * the Source tab.
   */
  const returnToSourceStep$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(internal.error$, null);
      set(internal.step$, "source");
      const source = get(internal.source$);
      if (source?.origin === "uploaded") {
        return;
      }
      releasePreviewUrl(source);
      set(internal.source$, null);
      set(internal.sourceUploaded$, false);
      set(internal.avatar$, null);
      set(internal.voice$, null);
      set(internal.placement$, "left");
      await settle(deleteIntroVideoDraft(), signal);
    },
  );
  const adoptUploadedRecording$ = command(
    ({ get, set }, recording: AdoptedIntroVideoRecording): void => {
      releasePreviewUrl(get(internal.source$));
      set(internal.source$, {
        contentType: recording.contentType,
        durationSeconds: null,
        kind: "video",
        name: recording.name,
        origin: "uploaded",
        previewUrl: recording.previewUrl,
        size: recording.size,
      });
      set(internal.adoptedAttachmentIds$, recording.attachmentIds);
      // The bytes are already stored under this account, so submit has nothing
      // to upload and the local draft store has nothing worth holding.
      set(internal.sourceUploaded$, true);
      set(internal.error$, null);
      set(internal.step$, "source-review");
      set(internal.open$, true);
    },
  );
  const setSourceFile$ = command(
    async (
      { get, set },
      file: File,
      kind: LocalIntroVideoSourceKind,
      signal: AbortSignal,
    ): Promise<void> => {
      const source = sourceFromFile(file, kind);
      releasePreviewUrl(get(internal.source$));
      set(internal.source$, source);
      set(internal.sourceUploaded$, false);
      set(internal.error$, null);
      if (get(internal.voice$)?.kind === "original") {
        set(internal.voice$, null);
      }
      set(internal.step$, stepAfterSource(source));
      // A failed save only costs the reload-restore convenience, so the wizard
      // carries on with the source it already holds in memory.
      await settle(saveIntroVideoDraft(draftFromSource(source)), signal);
    },
  );
  return {
    adoptUploadedRecording$,
    closeWizard$,
    openWizard$,
    returnToSourceStep$,
    setSourceFile$,
    setStep$,
  };
}

function createSelectionCommands(internal: IntroVideoInternalState) {
  const setAvatar$ = command(
    ({ set }, avatar: AvatarVideoAvatar | null): void => {
      set(internal.avatar$, avatar);
    },
  );
  const setVoice$ = command(
    ({ set }, voice: IntroVideoVoiceSelection | null): void => {
      set(internal.voice$, voice);
    },
  );
  const setInstructions$ = command(({ set }, instructions: string): void => {
    set(internal.instructions$, instructions);
  });
  const setPlacement$ = command(
    ({ set }, placement: IntroVideoPlacement): void => {
      set(internal.placement$, placement);
    },
  );
  return {
    setAvatar$,
    setInstructions$,
    setPlacement$,
    setVoice$,
  };
}

function createDownloadSourceCommand(internal: IntroVideoInternalState) {
  return command(({ get }): void => {
    const source = get(internal.source$);
    // An uploaded source is already safe on the server, so there is nothing
    // local to hand back when a send fails.
    if (source?.origin !== "local") {
      return;
    }
    const url = URL.createObjectURL(source.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = source.name;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

function createClearCompletedDraftCommand(
  internal: IntroVideoInternalState,
  resetWizardDraft$: Command<void, []>,
) {
  return command(
    async (
      { set },
      source: IntroVideoSource,
      signal: AbortSignal,
    ): Promise<void> => {
      // A stale local draft is harmless if cleanup fails after the server send.
      await settle(deleteIntroVideoDraft(), signal);
      releasePreviewUrl(source);
      set(resetWizardDraft$);
      // The send consumed the adopted handoff uploads, so the wizard stops
      // tracking them. Closing deliberately does not: those files stay on the
      // composer draft and only discardAdoptedAttachments$ can take them off.
      set(internal.adoptedAttachmentIds$, []);
    },
  );
}

function createSubmissionCommands(
  internal: IntroVideoInternalState,
  downloadSource$: Command<void, []>,
  resetWizardDraft$: Command<void, []>,
  discardAdoptedAttachments$: ReturnType<
    typeof createDiscardAdoptedAttachmentsCommand
  >,
) {
  const uploadSourceIfNeeded$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      source: IntroVideoSource,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (source.origin === "uploaded" || get(internal.sourceUploaded$)) {
        return true;
      }
      const before = new Set(get(composer.draft.attachments$));
      await set(composer.draft.uploadAttachment$, sourceFile(source), signal);
      signal.throwIfAborted();
      const uploaded = get(composer.draft.attachments$).some((attachment) => {
        return !before.has(attachment);
      });
      if (!uploaded) {
        set(internal.busy$, false);
        set(internal.error$, "upload-failed");
        set(downloadSource$);
        return false;
      }
      set(internal.sourceUploaded$, true);
      return true;
    },
  );
  const clearCompletedDraft$ = createClearCompletedDraftCommand(
    internal,
    resetWizardDraft$,
  );
  const submitComposer$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const action = await get(composer.submission.primaryAction$);
      signal.throwIfAborted();
      return await set(composer.submission.submitCurrentInput$, action, signal);
    },
  );
  const submit$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const source = get(internal.source$);
      if (!source) {
        set(internal.step$, "source");
        return false;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      if (source.origin === "local") {
        // The user replaced an adopted handoff source. Its uploads are still on
        // the draft and are no longer part of this request.
        await set(discardAdoptedAttachments$, composer, signal);
      }
      if (!(await set(uploadSourceIfNeeded$, composer, source, signal))) {
        return false;
      }
      // A deck, a screen recording, and an unclassified upload become a video
      // by entirely different means, so each entry sends its own workflow.
      set(
        composer.draft.setAgentInstructions$,
        introVideoAgentInstructions(source.kind),
      );
      set(
        composer.draft.setDraftInput$,
        buildIntroVideoPrompt({
          avatar: get(internal.avatar$),
          instructions: get(internal.instructions$),
          placement: get(internal.placement$),
          source,
          voice: get(internal.voice$),
        }),
      );
      const submission = await settle(
        set(submitComposer$, composer, signal),
        signal,
      );
      if (!submission.ok || !submission.value) {
        set(internal.sourceUploaded$, false);
        set(internal.busy$, false);
        set(internal.error$, "send-failed");
        set(downloadSource$);
        return false;
      }
      await set(clearCompletedDraft$, source, signal);
      return true;
    },
  );
  return { submit$ };
}

function createIntroVideoWizardSignals() {
  const internal = createIntroVideoInternalState();
  const selectors = createIntroVideoSelectors(internal);
  const resetWizardDraft$ = createResetWizardDraftCommand(internal);
  const sourceCommands = createSourceCommands(internal, resetWizardDraft$);
  const selectionCommands = createSelectionCommands(internal);
  const downloadSource$ = createDownloadSourceCommand(internal);
  const discardAdoptedAttachments$ =
    createDiscardAdoptedAttachmentsCommand(internal);
  const submissionCommands = createSubmissionCommands(
    internal,
    downloadSource$,
    resetWizardDraft$,
    discardAdoptedAttachments$,
  );
  return {
    ...selectors,
    ...sourceCommands,
    ...selectionCommands,
    ...submissionCommands,
    downloadSource$,
  };
}

export const introVideoWizardSignals = createIntroVideoWizardSignals();
