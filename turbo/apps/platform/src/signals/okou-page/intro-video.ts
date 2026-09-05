import type {
  IntroVideoAvatar,
  IntroVideoStyle,
  IntroVideoVoice,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state, type Command, type State } from "ccstate";

import type { ComposerSignals } from "./composer-signals.ts";
import { onRef, settle } from "../utils.ts";

export type IntroVideoWizardError = "send-failed" | "upload-failed";
export type IntroVideoPicker = "avatar" | "style" | "voice";
type IntroVideoSourceKind = "file" | "presentation" | "video";

interface IntroVideoSourceFacts {
  readonly contentType: string;
  readonly key: string;
  readonly kind: IntroVideoSourceKind;
  readonly name: string;
  readonly size: number;
}

interface LocalIntroVideoSource extends IntroVideoSourceFacts {
  readonly file: File;
  readonly origin: "local";
}

interface UploadedIntroVideoSource extends IntroVideoSourceFacts {
  readonly attachmentIds: readonly string[];
  readonly origin: "uploaded";
  readonly previewUrl: string | null;
}

export type IntroVideoSource = LocalIntroVideoSource | UploadedIntroVideoSource;

interface AdoptedIntroVideoRecording {
  readonly attachmentIds: readonly string[];
  readonly contentType: string;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

export type IntroVideoAvatarSelection =
  | { readonly kind: "auto" }
  | { readonly kind: "none" }
  | { readonly kind: "catalog"; readonly avatar: IntroVideoAvatar };

export type IntroVideoStyleSelection =
  | { readonly kind: "auto" }
  | { readonly kind: "none" }
  | { readonly kind: "catalog"; readonly style: IntroVideoStyle };

export type IntroVideoVoiceSelection =
  | { readonly kind: "default" }
  | { readonly kind: "catalog"; readonly voice: IntroVideoVoice }
  | { readonly kind: "none" }
  | { readonly kind: "original" };

const PRESENTATION_EXTENSIONS = ["html", "pdf", "ppt", "pptx"] as const;
const INTRO_VIDEO_ASPECT_RATIO_LABEL = "16:9";

function extensionForFilename(filename: string): string {
  return filename.split(".").pop()?.toLocaleLowerCase() ?? "";
}

function isIntroVideoPresentation(file: Pick<File, "name">): boolean {
  const extension = extensionForFilename(file.name);
  return PRESENTATION_EXTENSIONS.some((candidate) => {
    return candidate === extension;
  });
}

function sourceKind(file: File): IntroVideoSourceKind {
  if (file.type.startsWith("video/")) {
    return "video";
  }
  return isIntroVideoPresentation(file) ? "presentation" : "file";
}

function localSource(file: File): LocalIntroVideoSource {
  return {
    contentType: file.type || "application/octet-stream",
    file,
    key: crypto.randomUUID(),
    kind: sourceKind(file),
    name: file.name,
    origin: "local",
    size: file.size,
  };
}

function serializeStyleSelection(selection: IntroVideoStyleSelection): string {
  switch (selection.kind) {
    case "auto": {
      return "Auto — choose the best visual direction";
    }
    case "none": {
      return "No HeyGen style";
    }
    case "catalog": {
      return `${selection.style.name} (${selection.style.id})`;
    }
  }
}

function serializeAvatarSelection(
  selection: IntroVideoAvatarSelection,
): string {
  switch (selection.kind) {
    case "auto": {
      return "Auto — choose a suitable public HeyGen avatar when useful";
    }
    case "none": {
      return "No avatar";
    }
    case "catalog": {
      return `${selection.avatar.name} (${selection.avatar.id})`;
    }
  }
}

function serializeVoiceSelection(
  selection: IntroVideoVoiceSelection,
  avatar: IntroVideoAvatarSelection,
): string {
  switch (selection.kind) {
    case "default": {
      return avatar.kind === "catalog"
        ? `Default — follow ${avatar.avatar.name} (${avatar.avatar.defaultVoiceId})`
        : "Default — follow the chosen avatar";
    }
    case "catalog": {
      return `${selection.voice.name} (${selection.voice.id})`;
    }
    case "none": {
      return "No voiceover";
    }
    case "original": {
      return "Use original source audio";
    }
  }
}

function buildIntroVideoPrompt(args: {
  readonly avatar: IntroVideoAvatarSelection;
  readonly instructions: string;
  readonly sources: readonly IntroVideoSource[];
  readonly style: IntroVideoStyleSelection;
  readonly voice: IntroVideoVoiceSelection;
}): string {
  const request = args.instructions.trim();
  const sourceLines =
    args.sources.length === 0
      ? ["- Sources: none; research or create supporting material as needed"]
      : args.sources.map((source) => {
          return `- Source: ${source.name} (${source.kind})`;
        });
  const styleReference =
    args.style.kind === "catalog"
      ? [
          ...(args.style.style.thumbnailUrl
            ? [`- HeyGen style thumbnail: ${args.style.style.thumbnailUrl}`]
            : []),
          ...(args.style.style.previewVideoUrl
            ? [`- HeyGen style preview: ${args.style.style.previewVideoUrl}`]
            : []),
          ...(args.style.style.tags.length > 0
            ? [`- HeyGen style tags: ${args.style.style.tags.join(", ")}`]
            : []),
        ]
      : [];
  const avatarReference =
    args.avatar.kind === "catalog"
      ? [
          `- HeyGen avatar group ID: ${args.avatar.avatar.groupId}`,
          `- HeyGen avatar default voice ID: ${args.avatar.avatar.defaultVoiceId}`,
          ...(args.avatar.avatar.previewImageUrl
            ? [
                `- HeyGen avatar preview image: ${args.avatar.avatar.previewImageUrl}`,
              ]
            : []),
          ...(args.avatar.avatar.previewVideoUrl
            ? [
                `- HeyGen avatar preview video: ${args.avatar.avatar.previewVideoUrl}`,
              ]
            : []),
        ]
      : [];
  return [
    "Use the $intro-video skill to create one polished intro video.",
    "",
    "Configuration:",
    `- Aspect ratio: ${INTRO_VIDEO_ASPECT_RATIO_LABEL}`,
    `- HeyGen style: ${serializeStyleSelection(args.style)}`,
    `- Avatar: ${serializeAvatarSelection(args.avatar)}`,
    `- Voice: ${serializeVoiceSelection(args.voice, args.avatar)}`,
    ...styleReference,
    ...avatarReference,
    "",
    "Source attachments:",
    ...sourceLines,
    ...(request ? ["", "User request:", request] : []),
  ].join("\n");
}

interface IntroVideoInternalState {
  readonly avatar$: State<IntroVideoAvatarSelection>;
  readonly busy$: State<boolean>;
  readonly error$: State<IntroVideoWizardError | null>;
  readonly instructions$: State<string>;
  readonly open$: State<boolean>;
  readonly picker$: State<IntroVideoPicker | null>;
  readonly sources$: State<readonly IntroVideoSource[]>;
  readonly style$: State<IntroVideoStyleSelection>;
  readonly uploadedAttachmentKeys$: State<Readonly<Record<string, string>>>;
  readonly voice$: State<IntroVideoVoiceSelection>;
}

function createIntroVideoInternalState(): IntroVideoInternalState {
  return {
    avatar$: state<IntroVideoAvatarSelection>({ kind: "auto" }),
    busy$: state(false),
    error$: state<IntroVideoWizardError | null>(null),
    instructions$: state(""),
    open$: state(false),
    picker$: state<IntroVideoPicker | null>(null),
    sources$: state<readonly IntroVideoSource[]>([]),
    style$: state<IntroVideoStyleSelection>({ kind: "auto" }),
    uploadedAttachmentKeys$: state<Readonly<Record<string, string>>>({}),
    voice$: state<IntroVideoVoiceSelection>({ kind: "default" }),
  };
}

function exposeState<T>(signal: State<T>) {
  return computed((get) => {
    return get(signal);
  });
}

function createInputTargetSignals() {
  const input$ = state<HTMLInputElement | null>(null);
  const setInputRef$ = onRef(
    command(({ set }, input: HTMLInputElement, signal: AbortSignal): void => {
      signal.addEventListener("abort", () => {
        set(input$, null);
      });
      set(input$, input);
    }),
  );
  const openInput$ = command(({ get }): void => {
    const input = get(input$);
    if (!input) {
      throw new Error("Intro video file input is not mounted");
    }
    input.click();
  });
  return { openInput$, setInputRef$ };
}

const fileInputTarget = createInputTargetSignals();

function createResetDraftCommand(internal: IntroVideoInternalState) {
  return command(({ set }): void => {
    set(internal.avatar$, { kind: "auto" });
    set(internal.busy$, false);
    set(internal.error$, null);
    set(internal.instructions$, "");
    set(internal.open$, false);
    set(internal.picker$, null);
    set(internal.sources$, []);
    set(internal.style$, { kind: "auto" });
    set(internal.uploadedAttachmentKeys$, {});
    set(internal.voice$, { kind: "default" });
  });
}

function createCommands(
  internal: IntroVideoInternalState,
  resetDraft$: Command<void, []>,
) {
  const openWizard$ = command(({ set }, signal: AbortSignal): void => {
    signal.addEventListener(
      "abort",
      () => {
        set(internal.open$, false);
      },
      { once: true },
    );
    set(internal.error$, null);
    set(internal.open$, true);
  });
  const closeWizard$ = command(({ set }): void => {
    set(resetDraft$);
  });
  const setPicker$ = command(
    ({ set }, picker: IntroVideoPicker | null): void => {
      set(internal.picker$, picker);
    },
  );
  const addSourceFiles$ = command(({ set }, files: readonly File[]): void => {
    if (files.length === 0) {
      return;
    }
    set(internal.sources$, (sources) => {
      return [...sources, ...files.map(localSource)];
    });
    set(internal.error$, null);
  });
  const removeSource$ = command(
    async (
      { get, set },
      sourceKey: string,
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<void> => {
      const source = get(internal.sources$).find((candidate) => {
        return candidate.key === sourceKey;
      });
      if (!source) {
        return;
      }
      const uploadedKey = get(internal.uploadedAttachmentKeys$)[sourceKey];
      const uploadedIds =
        source.origin === "uploaded" ? source.attachmentIds : [];
      if (uploadedKey || uploadedIds.length > 0) {
        const resolved = await Promise.all(
          get(composer.draft.attachments$).map(async (attachment) => {
            return { attachment, info: await get(attachment.fileInfo$) };
          }),
        );
        signal.throwIfAborted();
        for (const { attachment, info } of resolved) {
          if (
            attachment.key === uploadedKey ||
            (info && uploadedIds.includes(info.id))
          ) {
            set(composer.draft.removeAttachment$, attachment);
          }
        }
      }
      set(internal.sources$, (sources) => {
        return sources.filter((candidate) => {
          return candidate.key !== sourceKey;
        });
      });
      set(internal.uploadedAttachmentKeys$, (keys) => {
        return Object.fromEntries(
          Object.entries(keys).filter(([key]) => {
            return key !== sourceKey;
          }),
        );
      });
      if (
        get(internal.voice$).kind === "original" &&
        !get(internal.sources$).some((candidate) => {
          return candidate.kind === "video";
        })
      ) {
        set(internal.voice$, { kind: "default" });
      }
    },
  );
  const adoptUploadedRecording$ = command(
    ({ set }, recording: AdoptedIntroVideoRecording): void => {
      set(internal.sources$, [
        {
          attachmentIds: recording.attachmentIds,
          contentType: recording.contentType,
          key: crypto.randomUUID(),
          kind: "video",
          name: recording.name,
          origin: "uploaded",
          previewUrl: recording.previewUrl,
          size: recording.size,
        },
      ]);
      set(internal.error$, null);
      set(internal.open$, true);
    },
  );
  return {
    addSourceFiles$,
    adoptUploadedRecording$,
    closeWizard$,
    openWizard$,
    removeSource$,
    setAvatar$: command(({ set }, avatar: IntroVideoAvatarSelection): void => {
      set(internal.avatar$, avatar);
    }),
    setInstructions$: command(({ set }, instructions: string): void => {
      set(internal.instructions$, instructions);
    }),
    setPicker$,
    setStyle$: command(({ set }, style: IntroVideoStyleSelection): void => {
      set(internal.style$, style);
    }),
    setVoice$: command(({ set }, voice: IntroVideoVoiceSelection): void => {
      set(internal.voice$, voice);
    }),
  };
}

function createSubmissionCommand(
  internal: IntroVideoInternalState,
  resetDraft$: Command<void, []>,
) {
  const uploadSources$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      for (const source of get(internal.sources$)) {
        if (
          source.origin === "uploaded" ||
          get(internal.uploadedAttachmentKeys$)[source.key]
        ) {
          continue;
        }
        const before = new Set(get(composer.draft.attachments$));
        const upload = await settle(
          set(composer.draft.uploadAttachment$, source.file, signal),
          signal,
        );
        if (!upload.ok) {
          set(internal.error$, "upload-failed");
          set(internal.busy$, false);
          return false;
        }
        const attachment = get(composer.draft.attachments$).find(
          (candidate) => {
            return !before.has(candidate);
          },
        );
        if (!attachment) {
          set(internal.error$, "upload-failed");
          set(internal.busy$, false);
          return false;
        }
        set(internal.uploadedAttachmentKeys$, (keys) => {
          return { ...keys, [source.key]: attachment.key };
        });
      }
      return true;
    },
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
  return command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const sources = get(internal.sources$);
      const instructions = get(internal.instructions$);
      if (sources.length === 0 && !instructions.trim()) {
        return false;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      if (!(await set(uploadSources$, composer, signal))) {
        return false;
      }
      set(
        composer.draft.setDraftInput$,
        buildIntroVideoPrompt({
          avatar: get(internal.avatar$),
          instructions,
          sources,
          style: get(internal.style$),
          voice: get(internal.voice$),
        }),
      );
      const submission = await settle(
        set(submitComposer$, composer, signal),
        signal,
      );
      if (!submission.ok || !submission.value) {
        set(internal.busy$, false);
        set(internal.error$, "send-failed");
        return false;
      }
      set(resetDraft$);
      return true;
    },
  );
}

function createIntroVideoWizardSignals() {
  const internal = createIntroVideoInternalState();
  const resetDraft$ = createResetDraftCommand(internal);
  return {
    avatar$: exposeState(internal.avatar$),
    busy$: exposeState(internal.busy$),
    error$: exposeState(internal.error$),
    instructions$: exposeState(internal.instructions$),
    open$: exposeState(internal.open$),
    picker$: exposeState(internal.picker$),
    source$: computed((get) => {
      return get(internal.sources$)[0] ?? null;
    }),
    sources$: exposeState(internal.sources$),
    style$: exposeState(internal.style$),
    voice$: exposeState(internal.voice$),
    ...createCommands(internal, resetDraft$),
    openFileInput$: fileInputTarget.openInput$,
    setFileInputRef$: fileInputTarget.setInputRef$,
    submit$: createSubmissionCommand(internal, resetDraft$),
  };
}

export const introVideoWizardSignals = createIntroVideoWizardSignals();
