import type {
  IntroVideoAvatar,
  IntroVideoStyle,
  IntroVideoVoice,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state, type Command, type State } from "ccstate";

import type { ComposerSignals } from "./composer-signals.ts";
import { createStandaloneAgentSubmission } from "./agent-composer-signals.ts";
import {
  createDraftSignals,
  inferUploadContentType,
  type DraftSignals,
} from "./chat-draft.ts";
import { onRef, settle } from "../utils.ts";

export type IntroVideoWizardError = "send-failed" | "upload-failed";
export type IntroVideoPicker = "avatar" | "style" | "voice";
type IntroVideoAspectRatio = "auto" | "16:9" | "9:16";
type IntroVideoSourceKind = "file" | "presentation" | "video" | "audio";

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
  | { readonly kind: "catalog"; readonly style: IntroVideoStyle };

export type IntroVideoVoiceSelection =
  | { readonly kind: "default" }
  | { readonly kind: "catalog"; readonly voice: IntroVideoVoice }
  | { readonly kind: "none" }
  | { readonly kind: "original" };

const PRESENTATION_EXTENSIONS = ["html", "pdf", "ppt", "pptx"] as const;

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
  const contentType = inferUploadContentType(file);
  if (contentType.startsWith("video/")) {
    return "video";
  }
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  return isIntroVideoPresentation(file) ? "presentation" : "file";
}

function localSource(file: File): LocalIntroVideoSource {
  return {
    contentType: inferUploadContentType(file),
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
      if (avatar.kind === "catalog") {
        return `Default — follow ${avatar.avatar.name} (${avatar.avatar.defaultVoiceId})`;
      }
      return avatar.kind === "none"
        ? "Auto — choose a suitable public HeyGen voice"
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
  readonly aspectRatio: IntroVideoAspectRatio;
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
          ...(args.style.style.aspectRatio
            ? [
                `- HeyGen style reference aspect ratio: ${args.style.style.aspectRatio}`,
              ]
            : []),
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
    `- Aspect ratio: ${args.aspectRatio === "auto" ? "Auto — infer from the user request, source material, and destination" : args.aspectRatio}`,
    `- HeyGen style: ${serializeStyleSelection(args.style)}`,
    `- Avatar: ${serializeAvatarSelection(args.avatar)}`,
    `- Voice: ${serializeVoiceSelection(args.voice, args.avatar)}`,
    ...styleReference,
    ...avatarReference,
    "- Treat the selected style as a visual reference for the managed composition route, not a native HeyGen template or an executed style_id.",
    "- An explicit output aspect ratio is independent of the style reference. If it conflicts with an explicit user request, clarify before rendering.",
    "",
    "Source attachments:",
    ...sourceLines,
    ...(request ? ["", "User request:", request] : []),
  ].join("\n");
}

interface IntroVideoInternalState {
  readonly aspectRatio$: State<IntroVideoAspectRatio>;
  readonly draft: DraftSignals;
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
    aspectRatio$: state<IntroVideoAspectRatio>("auto"),
    draft: createDraftSignals(),
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
    set(internal.aspectRatio$, "auto");
    set(internal.draft.clear$);
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

function createCloseWizardCommand(
  internal: IntroVideoInternalState,
  resetDraft$: Command<void, []>,
) {
  return command(({ get, set }): void => {
    if (!get(internal.busy$)) {
      set(resetDraft$);
    }
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
        set(resetDraft$);
      },
      { once: true },
    );
    set(internal.error$, null);
    set(internal.open$, true);
  });
  const setPicker$ = command(
    ({ set }, picker: IntroVideoPicker | null): void => {
      set(internal.picker$, picker);
    },
  );
  const addSourceFiles$ = command(
    ({ get, set }, files: readonly File[]): void => {
      if (get(internal.busy$) || files.length === 0) {
        return;
      }
      set(internal.sources$, (sources) => {
        return [...sources, ...files.map(localSource)];
      });
      set(internal.error$, null);
    },
  );
  const removeSource$ = command(
    async (
      { get, set },
      sourceKey: string,
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
          get(internal.draft.attachments$).map(async (attachment) => {
            return { attachment, info: await get(attachment.fileInfo$) };
          }),
        );
        signal.throwIfAborted();
        for (const { attachment, info } of resolved) {
          if (
            attachment.key === uploadedKey ||
            (info && uploadedIds.includes(info.id))
          ) {
            set(internal.draft.removeAttachment$, attachment);
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
          return candidate.kind === "video" || candidate.kind === "audio";
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
    closeWizard$: createCloseWizardCommand(internal, resetDraft$),
    openWizard$,
    removeSource$,
    setAvatar$: command(({ set }, avatar: IntroVideoAvatarSelection): void => {
      set(internal.avatar$, avatar);
    }),
    setInstructions$: command(({ set }, instructions: string): void => {
      set(internal.instructions$, instructions);
    }),
    setPicker$,
    setAspectRatio$: command(
      ({ set }, aspectRatio: IntroVideoAspectRatio): void => {
        set(internal.aspectRatio$, aspectRatio);
      },
    ),
    setStyle$: command(({ set }, style: IntroVideoStyleSelection): void => {
      set(internal.style$, style);
    }),
    setVoice$: command(({ set }, voice: IntroVideoVoiceSelection): void => {
      set(internal.voice$, voice);
    }),
  };
}

function createUploadSourcesCommand(internal: IntroVideoInternalState) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      for (const source of get(internal.sources$)) {
        const uploadedKey = get(internal.uploadedAttachmentKeys$)[source.key];
        if (
          source.origin === "uploaded" ||
          get(internal.draft.attachments$).some((attachment) => {
            return attachment.key === uploadedKey;
          })
        ) {
          continue;
        }
        const before = new Set(get(internal.draft.attachments$));
        const upload = await settle(
          set(internal.draft.uploadAttachment$, source.file, signal),
          signal,
        );
        if (!upload.ok) {
          set(internal.error$, "upload-failed");
          set(internal.busy$, false);
          return false;
        }
        const attachment = get(internal.draft.attachments$).find(
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
}

function createSubmissionCommand(
  internal: IntroVideoInternalState,
  resetDraft$: Command<void, []>,
) {
  const uploadSources$ = createUploadSourcesCommand(internal);
  const restoreSources$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const sourceIds = get(internal.sources$).flatMap((source) => {
        return source.origin === "uploaded" ? source.attachmentIds : [];
      });
      if (sourceIds.length === 0) {
        return true;
      }
      const existing = await Promise.all(
        get(internal.draft.attachments$).map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const missingIds = sourceIds.filter((id) => {
        return !existing.some((info) => {
          return info?.id === id;
        });
      });
      const originals = await Promise.all(
        get(composer.draft.attachments$).map(async (attachment) => {
          const info = await get(attachment.fileInfo$);
          return info
            ? { ...info, filename: attachment.filename, size: attachment.size }
            : null;
        }),
      );
      signal.throwIfAborted();
      const attachments = originals.flatMap((info) => {
        return info !== null && missingIds.includes(info.id) ? [info] : [];
      });
      if (attachments.length !== missingIds.length) {
        return false;
      }
      return !(await set(
        internal.draft.restoreAttachments$,
        attachments,
        signal,
      ));
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
      if (
        get(internal.busy$) ||
        (sources.length === 0 && !instructions.trim())
      ) {
        return false;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      const restored = await settle(
        set(restoreSources$, composer, signal),
        signal,
      );
      if (!restored.ok || !restored.value) {
        set(internal.busy$, false);
        set(internal.error$, "upload-failed");
        return false;
      }
      if (!(await set(uploadSources$, signal))) {
        return false;
      }
      const prompt = buildIntroVideoPrompt({
        aspectRatio: get(internal.aspectRatio$),
        avatar: get(internal.avatar$),
        instructions,
        sources,
        style: get(internal.style$),
        voice: get(internal.voice$),
      });
      const submitDraft$ = createStandaloneAgentSubmission(
        composer.agentId,
        internal.draft,
        composer.connector,
      );
      const submission = await settle(
        set(
          submitDraft$,
          "send",
          {
            prompt,
            generationTemplate: undefined,
            editorDocument: undefined,
            videoRunOptions: undefined,
          },
          signal,
        ),
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
    aspectRatio$: exposeState(internal.aspectRatio$),
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
