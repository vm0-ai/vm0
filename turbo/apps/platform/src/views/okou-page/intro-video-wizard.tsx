import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Download,
  FileText,
  MessageCircle,
  Mic,
  MonitorUp,
  Play,
  RefreshCw,
  Upload,
  UserRound,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch,
  Textarea,
  cn,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  classifyIntroVideoSource,
  introVideoWizardSignals,
  type IntroVideoSource,
  type IntroVideoVoiceSelection,
  type IntroVideoWizardError,
  type IntroVideoWizardStep,
} from "../../signals/okou-page/intro-video.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  AvatarLibraryContent,
  AvatarLibraryToolbar,
  VoiceLibraryContent,
  VoiceLibraryToolbar,
} from "./avatar-template-picker.tsx";

const DOCUMENT_ACCEPT =
  ".doc,.docx,.pdf,.ppt,.pptx,application/msword,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const VIDEO_ACCEPT = ".mov,.mp4,.webm,video/mp4,video/quicktime,video/webm";
const ALL_SOURCE_ACCEPT = `${DOCUMENT_ACCEPT},${VIDEO_ACCEPT}`;

function wizardStage(step: IntroVideoWizardStep): number {
  switch (step) {
    case "avatar": {
      return 1;
    }
    case "voice": {
      return 2;
    }
    case "review": {
      return 3;
    }
    default: {
      return 0;
    }
  }
}

function stepForStage(
  stage: number,
  source: IntroVideoSource | null,
): IntroVideoWizardStep {
  switch (stage) {
    case 1: {
      return "avatar";
    }
    case 2: {
      return "voice";
    }
    case 3: {
      return "review";
    }
    default: {
      return source ? "source-review" : "source";
    }
  }
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function sourceFormat(source: IntroVideoSource): string {
  const extension = source.name.split(".").pop()?.toLocaleUpperCase();
  return extension || source.contentType;
}

function sourceKindLabel(
  t: TFunction<"common">,
  source: IntroVideoSource,
): string {
  switch (source.kind) {
    case "document": {
      return t(($) => {
        return $.chat.introVideo.source.documentTitle;
      });
    }
    case "video": {
      return t(($) => {
        return $.chat.introVideo.source.videoTitle;
      });
    }
    case "recording": {
      return t(($) => {
        return $.chat.introVideo.source.recordTitle;
      });
    }
  }
}

function voiceLabel(
  t: TFunction<"common">,
  selection: IntroVideoVoiceSelection | null,
): string {
  switch (selection?.kind) {
    case "catalog": {
      return selection.voice.name;
    }
    case "original": {
      return t(($) => {
        return $.chat.introVideo.voice.original;
      });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    default: {
      return "—";
    }
  }
}

function WizardStepButton({
  active,
  completed,
  disabled,
  index,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly completed: boolean;
  readonly disabled: boolean;
  readonly index: number;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "step" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary/10 text-primary"
          : completed
            ? "text-foreground hover:bg-state-hover"
            : "text-muted-foreground hover:bg-state-hover disabled:pointer-events-none disabled:opacity-45",
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full border text-[10px]",
          active
            ? "border-primary bg-primary text-primary-foreground"
            : completed
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border bg-background",
        )}
      >
        {completed ? <Check size={11} /> : index + 1}
      </span>
      {label}
    </button>
  );
}

function SourceChoice({
  description,
  detail,
  icon,
  title,
  onClick,
  disabled = false,
}: {
  readonly description: string;
  readonly detail: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex min-h-32 min-w-0 items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">
          {description}
        </span>
        <span className="mt-2 block text-xs text-muted-foreground/80">
          {detail}
        </span>
      </span>
    </button>
  );
}

function clickFileInput(selector: string): void {
  document.querySelector<HTMLInputElement>(selector)?.click();
}

function SourceOptions({
  busy,
  onRecord,
  onStartInChat,
}: {
  readonly busy: boolean;
  readonly onRecord: () => void;
  readonly onStartInChat: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.documentTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.documentDescription;
        })}
        detail={t(($) => {
          return $.chat.introVideo.source.documentFormats;
        })}
        icon={<FileText size={21} />}
        onClick={() => {
          clickFileInput('[data-intro-video-document-input=""]');
        }}
      />
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.videoTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.videoDescription;
        })}
        detail={t(($) => {
          return $.chat.introVideo.source.videoFormats;
        })}
        icon={<Video size={21} />}
        onClick={() => {
          clickFileInput('[data-intro-video-recording-input=""]');
        }}
      />
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.recordTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.recordDescription;
        })}
        detail={t(($) => {
          return $.chat.introVideo.source.recordDetail;
        })}
        icon={<MonitorUp size={21} />}
        onClick={onRecord}
      />
      <SourceChoice
        title={t(($) => {
          return $.chat.introVideo.source.chatTitle;
        })}
        description={t(($) => {
          return $.chat.introVideo.source.chatDescription;
        })}
        detail={t(($) => {
          return $.chat.introVideo.source.chatDetail;
        })}
        icon={<MessageCircle size={21} />}
        disabled={busy}
        onClick={onStartInChat}
      />
    </div>
  );
}

function SourceDropTarget({
  onDrop,
}: {
  readonly onDrop: (event: ReactDragEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-dragging="false"
      onClick={() => {
        clickFileInput('[data-intro-video-source-input=""]');
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        event.currentTarget.dataset.dragging = "true";
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        event.currentTarget.dataset.dragging = "true";
      }}
      onDragLeave={(event) => {
        event.currentTarget.dataset.dragging = "false";
      }}
      onDrop={onDrop}
      className="group mt-3 flex min-h-24 items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-background px-6 py-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:border-primary data-[dragging=true]:bg-primary/5"
    >
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground group-hover:text-primary">
        <Upload size={19} />
      </span>
      <span>
        <strong className="block text-sm font-semibold text-foreground">
          {t(($) => {
            return $.chat.introVideo.source.dropTitle;
          })}
        </strong>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.source.dropDescription;
          })}
        </span>
      </span>
    </button>
  );
}

function SourceFileInputs({
  onChange,
}: {
  readonly onChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <input
        hidden
        data-intro-video-document-input=""
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={onChange}
      />
      <input
        hidden
        data-intro-video-recording-input=""
        type="file"
        accept={VIDEO_ACCEPT}
        onChange={onChange}
      />
      <input
        hidden
        data-intro-video-source-input=""
        type="file"
        accept={ALL_SOURCE_ACCEPT}
        onChange={onChange}
      />
    </>
  );
}

function SourcePage({
  composer,
  busy,
}: {
  readonly composer: ComposerSignals;
  readonly busy: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const setSourceFile = useSet(introVideoWizardSignals.setSourceFile$);
  const setStep = useSet(introVideoWizardSignals.setStep$);
  const submitDirectChat = useSet(introVideoWizardSignals.submitDirectChat$);

  const receiveFile = (file: File | undefined) => {
    if (!file) {
      return;
    }
    const kind = classifyIntroVideoSource(file);
    if (!kind || kind === "recording") {
      return;
    }
    detach(
      setSourceFile(file, kind, pageSignal),
      Reason.DomCallback,
      "select intro video source",
    );
  };
  const handleFileChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    receiveFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = "";
  };
  const handleDrop = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.dataset.dragging = "false";
    receiveFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <h3 className="text-xl font-semibold tracking-tight text-foreground">
        {t(($) => {
          return $.chat.introVideo.source.heading;
        })}
      </h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.source.help;
        })}
      </p>
      <SourceOptions
        busy={busy}
        onRecord={() => {
          setStep("record-setup");
        }}
        onStartInChat={() => {
          detach(
            submitDirectChat(composer, pageSignal),
            Reason.DomCallback,
            "start intro video in chat",
          );
        }}
      />
      <SourceDropTarget onDrop={handleDrop} />
      <SourceFileInputs onChange={handleFileChange} />
    </div>
  );
}

function RecordingSetupPage() {
  const { t } = useTranslation();
  const systemAudio = useGet(introVideoWizardSignals.systemAudio$);
  const microphone = useGet(introVideoWizardSignals.microphone$);
  const setSystemAudio = useSet(introVideoWizardSignals.setSystemAudio$);
  const setMicrophone = useSet(introVideoWizardSignals.setMicrophone$);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8 md:grid-cols-[1.05fr_1fr] md:items-center">
      <div className="flex min-h-72 items-center justify-center rounded-2xl border border-border bg-gray-50 p-8">
        <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex h-9 items-center gap-1.5 border-b border-border px-3">
            <span className="size-2 rounded-full bg-red-400" />
            <span className="size-2 rounded-full bg-amber-400" />
            <span className="size-2 rounded-full bg-emerald-400" />
          </div>
          <div className="grid min-h-48 place-items-center p-6 text-center">
            <div>
              <MonitorUp className="mx-auto size-9 text-primary" />
              <p className="mt-3 text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.chat.introVideo.recording.chooseSurface;
                })}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.introVideo.recording.heading;
          })}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.recording.description;
          })}
        </p>
        <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card px-4">
          <label className="flex items-center justify-between gap-4 py-4">
            <span className="flex items-start gap-3">
              <Volume2 className="mt-0.5 size-4 text-muted-foreground" />
              <span>
                <strong className="block text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.chat.introVideo.recording.systemAudio;
                  })}
                </strong>
                <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {t(($) => {
                    return $.chat.introVideo.recording.systemAudioHelp;
                  })}
                </small>
              </span>
            </span>
            <Switch checked={systemAudio} onCheckedChange={setSystemAudio} />
          </label>
          <label className="flex items-center justify-between gap-4 py-4">
            <span className="flex items-start gap-3">
              <Mic className="mt-0.5 size-4 text-muted-foreground" />
              <span>
                <strong className="block text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.chat.introVideo.recording.microphone;
                  })}
                </strong>
                <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {t(($) => {
                    return $.chat.introVideo.recording.microphoneHelp;
                  })}
                </small>
              </span>
            </span>
            <Switch checked={microphone} onCheckedChange={setMicrophone} />
          </label>
        </div>
        <p className="mt-4 rounded-lg bg-primary/5 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.recording.localNote;
          })}
        </p>
      </div>
    </div>
  );
}

function RecordingPage({
  countdown,
  seconds,
}: {
  readonly countdown: number | null;
  readonly seconds: number;
}) {
  const { t } = useTranslation();
  const setPreviewRef = useSet(introVideoWizardSignals.setRecordingPreviewRef$);
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl items-center justify-center">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-border bg-gray-950 shadow-sm">
        <video
          ref={setPreviewRef}
          muted
          autoPlay
          playsInline
          className="h-full w-full object-contain"
        />
        {countdown !== null ? (
          <div className="absolute inset-0 grid place-items-center bg-gray-950/55 text-center backdrop-blur-[2px]">
            <div>
              <span className="block text-7xl font-semibold tabular-nums text-white">
                {countdown}
              </span>
              <span className="mt-3 block text-sm font-medium text-white/80">
                {t(($) => {
                  return $.chat.introVideo.recording.countdown;
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className="absolute inset-x-4 bottom-4 flex items-center gap-2 rounded-xl bg-gray-950/80 px-3 py-2 text-white shadow-lg backdrop-blur">
            <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
            <span className="font-mono text-xs tabular-nums">
              {formatDuration(seconds)}
            </span>
            <span className="text-xs text-white/70">
              {t(($) => {
                return $.chat.introVideo.recording.recordingLocally;
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceReviewPage({
  source,
  persisted,
}: {
  readonly source: IntroVideoSource;
  readonly persisted: boolean;
}) {
  const { t } = useTranslation();
  const setStep = useSet(introVideoWizardSignals.setStep$);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-8 md:grid-cols-[1.2fr_0.8fr] md:items-center">
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-2xl border border-border bg-gray-50">
        {source.previewUrl ? (
          <video
            src={source.previewUrl}
            controls
            playsInline
            className="h-full w-full bg-gray-950 object-contain"
          />
        ) : (
          <div className="text-center">
            <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary">
              <FileText size={28} />
            </span>
            <div className="mx-auto mt-5 flex w-44 flex-col gap-2">
              <span className="h-2 rounded-full bg-gray-300" />
              <span className="h-2 w-4/5 rounded-full bg-gray-200" />
              <span className="h-2 w-3/5 rounded-full bg-gray-200" />
            </div>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.chat.introVideo.sourceReview.heading;
          })}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.sourceReview.help;
          })}
        </p>
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card p-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {source.kind === "document" ? (
              <FileText size={18} />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block truncate text-sm font-medium text-foreground">
              {source.name}
            </strong>
            <small className="mt-0.5 block text-xs text-muted-foreground">
              {formatBytes(source.size)}
              {source.durationSeconds === null
                ? ""
                : ` · ${formatDuration(source.durationSeconds)}`}
            </small>
          </span>
        </div>
        <dl className="mt-5 divide-y divide-border text-sm">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.source;
              })}
            </dt>
            <dd className="font-medium text-foreground">
              {sourceKindLabel(t, source)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.format;
              })}
            </dt>
            <dd className="font-medium text-foreground">
              {sourceFormat(source)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.chat.introVideo.sourceReview.saved;
              })}
            </dt>
            <dd className="text-right font-medium text-foreground">
              {persisted
                ? t(($) => {
                    return $.chat.introVideo.sourceReview.inBrowser;
                  })
                : t(($) => {
                    return $.chat.introVideo.sourceReview.inTab;
                  })}
            </dd>
          </div>
        </dl>
        <Button
          type="button"
          variant="outline"
          className="mt-5"
          onClick={() => {
            setStep("source");
          }}
        >
          <RefreshCw size={15} />
          {t(($) => {
            return $.chat.introVideo.sourceReview.replace;
          })}
        </Button>
      </div>
    </div>
  );
}

function AvatarPage({ composer }: { readonly composer: ComposerSignals }) {
  const { t } = useTranslation();
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const setAvatar = useSet(introVideoWizardSignals.setAvatar$);
  const setAspectRatio = useSet(introVideoWizardSignals.setAspectRatio$);
  const selectAvatarForVoice = useSet(
    composer.template.selectAvatarTemplateForVoice$,
  );
  const clearAvatarForVoice = useSet(
    composer.template.clearAvatarTemplateVoiceSelection$,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.chat.introVideo.avatar.heading;
            })}
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.introVideo.avatar.help;
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={avatar ? "outline" : "secondary"}
            aria-pressed={!avatar}
            onClick={() => {
              clearAvatarForVoice();
              setAvatar(null);
            }}
          >
            <UserRound size={15} />
            {t(($) => {
              return $.chat.introVideo.avatar.skip;
            })}
          </Button>
          <AvatarLibraryToolbar
            signals={composer}
            onAspectRatioChange={setAspectRatio}
          />
        </div>
      </div>
      <AvatarLibraryContent
        signals={composer}
        selectedAvatarId={avatar?.id}
        onSelect={(nextAvatar) => {
          setAvatar(nextAvatar);
          selectAvatarForVoice(nextAvatar);
        }}
      />
    </div>
  );
}

function VoiceUtilityCard({
  description,
  icon,
  selected,
  title,
  onSelect,
}: {
  readonly description: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  readonly title: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/[0.04]" : "border-border",
      )}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold text-foreground">
          {title}
        </strong>
        <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </small>
      </span>
      {selected ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={13} />
        </span>
      ) : null}
    </button>
  );
}

function VoicePage({
  composer,
  source,
}: {
  readonly composer: ComposerSignals;
  readonly source: IntroVideoSource;
}) {
  const { t } = useTranslation();
  const voice = useGet(introVideoWizardSignals.voice$);
  const setVoice = useSet(introVideoWizardSignals.setVoice$);
  const originalAudioAvailable =
    source.kind === "recording" || source.kind === "video";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.chat.introVideo.voice.heading;
            })}
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.introVideo.voice.help;
            })}
          </p>
        </div>
        <VoiceLibraryToolbar signals={composer} />
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {originalAudioAvailable ? (
          <VoiceUtilityCard
            title={t(($) => {
              return $.chat.introVideo.voice.original;
            })}
            description={t(($) => {
              return $.chat.introVideo.voice.originalDescription;
            })}
            icon={<Volume2 size={18} />}
            selected={voice?.kind === "original"}
            onSelect={() => {
              setVoice({ kind: "original" });
            }}
          />
        ) : null}
        <VoiceUtilityCard
          title={t(($) => {
            return $.chat.introVideo.voice.none;
          })}
          description={t(($) => {
            return $.chat.introVideo.voice.noneDescription;
          })}
          icon={<VolumeX size={18} />}
          selected={voice?.kind === "none"}
          onSelect={() => {
            setVoice({ kind: "none" });
          }}
        />
      </div>
      <VoiceLibraryContent
        signals={composer}
        selectedVoiceId={voice?.kind === "catalog" ? voice.voice.id : undefined}
        onSelect={(selectedVoice) => {
          setVoice({ kind: "catalog", voice: selectedVoice });
        }}
      />
    </div>
  );
}

function ReviewItem({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <strong className="mt-0.5 block truncate text-sm font-medium text-foreground">
          {value}
        </strong>
      </span>
    </div>
  );
}

function ReviewPage({ source }: { readonly source: IntroVideoSource }) {
  const { t } = useTranslation();
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const aspectRatio = useGet(introVideoWizardSignals.aspectRatio$);
  const instructions = useGet(introVideoWizardSignals.instructions$);
  const setInstructions = useSet(introVideoWizardSignals.setInstructions$);
  return (
    <div className="mx-auto w-full max-w-4xl">
      <h3 className="text-xl font-semibold tracking-tight text-foreground">
        {t(($) => {
          return $.chat.introVideo.review.heading;
        })}
      </h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        {t(($) => {
          return $.chat.introVideo.review.help;
        })}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.source;
          })}
          value={`${source.name} · ${aspectRatio === "portrait" ? "9:16" : "16:9"}`}
          icon={
            source.kind === "document" ? (
              <FileText size={18} />
            ) : (
              <Video size={18} />
            )
          }
        />
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.avatar;
          })}
          value={
            avatar?.name ??
            t(($) => {
              return $.chat.introVideo.avatar.skip;
            })
          }
          icon={<UserRound size={18} />}
        />
        <ReviewItem
          label={t(($) => {
            return $.chat.introVideo.review.voice;
          })}
          value={voiceLabel(t, voice)}
          icon={<Volume2 size={18} />}
        />
      </div>
      <label className="mt-6 block">
        <span className="mb-2 block text-sm font-medium text-foreground">
          {t(($) => {
            return $.chat.introVideo.review.instructions;
          })}
        </span>
        <Textarea
          value={instructions}
          rows={5}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
          }}
          className="resize-none bg-card leading-6"
        />
      </label>
    </div>
  );
}

function errorCopy(
  t: TFunction<"common">,
  error: IntroVideoWizardError,
): string {
  switch (error) {
    case "recording-empty": {
      return t(($) => {
        return $.chat.introVideo.errors.recordingEmpty;
      });
    }
    case "recording-failed": {
      return t(($) => {
        return $.chat.introVideo.errors.recordingFailed;
      });
    }
    case "recording-permission": {
      return t(($) => {
        return $.chat.introVideo.errors.recordingPermission;
      });
    }
    case "recording-share-ended": {
      return t(($) => {
        return $.chat.introVideo.errors.recordingShareEnded;
      });
    }
    case "recording-unsupported": {
      return t(($) => {
        return $.chat.introVideo.errors.recordingUnsupported;
      });
    }
    case "send-failed": {
      return t(($) => {
        return $.chat.introVideo.errors.sendFailed;
      });
    }
    case "upload-failed": {
      return t(($) => {
        return $.chat.introVideo.errors.uploadFailed;
      });
    }
  }
}

function primaryLabel(
  t: TFunction<"common">,
  step: IntroVideoWizardStep,
): string | null {
  switch (step) {
    case "record-setup": {
      return t(($) => {
        return $.chat.introVideo.footer.startRecording;
      });
    }
    case "recording": {
      return t(($) => {
        return $.chat.introVideo.footer.stopRecording;
      });
    }
    case "source-review":
    case "avatar":
    case "voice": {
      return t(($) => {
        return $.chat.introVideo.footer.next;
      });
    }
    case "review": {
      return t(($) => {
        return $.chat.introVideo.footer.createInChat;
      });
    }
    default: {
      return null;
    }
  }
}

function previousWizardStep(
  step: IntroVideoWizardStep,
): IntroVideoWizardStep | null {
  switch (step) {
    case "record-setup":
    case "source-review": {
      return "source";
    }
    case "avatar": {
      return "source-review";
    }
    case "voice": {
      return "avatar";
    }
    case "review": {
      return "voice";
    }
    default: {
      return null;
    }
  }
}

function nextWizardStep(
  step: IntroVideoWizardStep,
): IntroVideoWizardStep | null {
  switch (step) {
    case "source-review": {
      return "avatar";
    }
    case "avatar": {
      return "voice";
    }
    case "voice": {
      return "review";
    }
    default: {
      return null;
    }
  }
}

function draftStatusCopy(
  t: TFunction<"common">,
  source: IntroVideoSource | null,
  sourcePersisted: boolean,
): string {
  if (!source) {
    return t(($) => {
      return $.chat.introVideo.footer.localUntilSend;
    });
  }
  return sourcePersisted
    ? t(($) => {
        return $.chat.introVideo.footer.draftSaved;
      })
    : t(($) => {
        return $.chat.introVideo.footer.draftInTab;
      });
}

function WizardErrorBanner({
  error,
  source,
  onDownload,
}: {
  readonly error: IntroVideoWizardError;
  readonly source: IntroVideoSource | null;
  readonly onDownload: () => void;
}) {
  const { t } = useTranslation();
  const canDownload =
    source && (error === "upload-failed" || error === "send-failed");
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <span>{errorCopy(t, error)}</span>
      {canDownload ? (
        <Button type="button" size="xs" variant="outline" onClick={onDownload}>
          <Download size={14} />
          {t(($) => {
            return $.chat.introVideo.footer.download;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function WizardFooter({
  busy,
  error,
  source,
  sourcePersisted,
  step,
  voice,
  composer,
}: {
  readonly busy: boolean;
  readonly error: IntroVideoWizardError | null;
  readonly source: IntroVideoSource | null;
  readonly sourcePersisted: boolean;
  readonly step: IntroVideoWizardStep;
  readonly voice: IntroVideoVoiceSelection | null;
  readonly composer: ComposerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const setStep = useSet(introVideoWizardSignals.setStep$);
  const startRecording = useSet(introVideoWizardSignals.startRecording$);
  const stopRecording = useSet(introVideoWizardSignals.stopRecording$);
  const submit = useSet(introVideoWizardSignals.submit$);
  const downloadSource = useSet(introVideoWizardSignals.downloadSource$);
  const label = primaryLabel(t, step);
  const goBack = () => {
    const previous = previousWizardStep(step);
    if (previous) {
      setStep(previous);
    }
  };
  const activatePrimary = () => {
    if (step === "record-setup") {
      detach(
        startRecording(pageSignal),
        Reason.DomCallback,
        "start intro video screen recording",
      );
      return;
    }
    if (step === "recording") {
      detach(
        stopRecording(pageSignal),
        Reason.DomCallback,
        "stop intro video screen recording",
      );
      return;
    }
    if (step === "review") {
      detach(
        submit(composer, pageSignal),
        Reason.DomCallback,
        "create intro video chat thread",
      );
      return;
    }
    const next = nextWizardStep(step);
    if (next) {
      setStep(next);
    }
  };
  const canGoBack = !busy && step !== "source" && step !== "countdown";
  const primaryDisabled =
    busy ||
    (step === "voice" && voice === null) ||
    (step === "review" && (!source || voice === null));
  return (
    <footer className="shrink-0 border-t border-border bg-card px-5 py-3.5 sm:px-6">
      {error ? (
        <WizardErrorBanner
          error={error}
          source={source}
          onDownload={downloadSource}
        />
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {draftStatusCopy(t, source, sourcePersisted)}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {canGoBack ? (
            <Button type="button" variant="ghost" onClick={goBack}>
              <ArrowLeft size={15} />
              {t(($) => {
                return $.chat.introVideo.footer.back;
              })}
            </Button>
          ) : null}
          {label ? (
            <Button
              type="button"
              disabled={primaryDisabled}
              onClick={activatePrimary}
            >
              {busy ? <RefreshCw className="animate-spin" size={15} /> : null}
              {label}
            </Button>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function WizardContent({
  busy,
  composer,
  countdown,
  recordingSeconds,
  source,
  sourcePersisted,
  step,
}: {
  readonly busy: boolean;
  readonly composer: ComposerSignals;
  readonly countdown: number;
  readonly recordingSeconds: number;
  readonly source: IntroVideoSource | null;
  readonly sourcePersisted: boolean;
  readonly step: IntroVideoWizardStep;
}) {
  switch (step) {
    case "source": {
      return <SourcePage composer={composer} busy={busy} />;
    }
    case "record-setup": {
      return <RecordingSetupPage />;
    }
    case "countdown": {
      return <RecordingPage countdown={countdown} seconds={recordingSeconds} />;
    }
    case "recording": {
      return <RecordingPage countdown={null} seconds={recordingSeconds} />;
    }
    case "source-review": {
      return source ? (
        <SourceReviewPage source={source} persisted={sourcePersisted} />
      ) : (
        <SourcePage composer={composer} busy={busy} />
      );
    }
    case "avatar": {
      return <AvatarPage composer={composer} />;
    }
    case "voice": {
      return source ? (
        <VoicePage composer={composer} source={source} />
      ) : (
        <SourcePage composer={composer} busy={busy} />
      );
    }
    case "review": {
      return source ? (
        <ReviewPage source={source} />
      ) : (
        <SourcePage composer={composer} busy={busy} />
      );
    }
  }
}

function WizardHeader({
  busy,
  source,
  step,
}: {
  readonly busy: boolean;
  readonly source: IntroVideoSource | null;
  readonly step: IntroVideoWizardStep;
}) {
  const { t } = useTranslation();
  const setStep = useSet(introVideoWizardSignals.setStep$);
  const activeStage = wizardStage(step);
  const stepLabels = [
    t(($) => {
      return $.chat.introVideo.steps.source;
    }),
    t(($) => {
      return $.chat.introVideo.steps.avatar;
    }),
    t(($) => {
      return $.chat.introVideo.steps.voice;
    }),
    t(($) => {
      return $.chat.introVideo.steps.review;
    }),
  ];
  return (
    <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Clapperboard size={18} />
          </span>
          <DialogTitle className="truncate text-base font-semibold">
            {t(($) => {
              return $.chat.introVideo.title;
            })}
          </DialogTitle>
        </div>
        <nav
          aria-label={t(($) => {
            return $.chat.introVideo.steps.label;
          })}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {stepLabels.map((label, index) => {
            return (
              <WizardStepButton
                key={label}
                index={index}
                label={label}
                active={index === activeStage}
                completed={index < activeStage}
                disabled={busy || (index > 0 && !source)}
                onClick={() => {
                  setStep(stepForStage(index, source));
                }}
              />
            );
          })}
        </nav>
      </div>
      <DialogDescription
        id="intro-video-wizard-description"
        className="sr-only"
      >
        {t(($) => {
          return $.chat.introVideo.description;
        })}
      </DialogDescription>
    </DialogHeader>
  );
}

export function IntroVideoWizard({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const open = useGet(introVideoWizardSignals.open$);
  const step = useGet(introVideoWizardSignals.step$);
  const source = useGet(introVideoWizardSignals.source$);
  const sourcePersisted = useGet(introVideoWizardSignals.sourcePersisted$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const countdown = useGet(introVideoWizardSignals.countdown$);
  const recordingSeconds = useGet(introVideoWizardSignals.recordingSeconds$);
  const busy = useGet(introVideoWizardSignals.busy$);
  const error = useGet(introVideoWizardSignals.error$);
  const closeWizard = useSet(introVideoWizardSignals.closeWizard$);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeWizard();
        }
      }}
    >
      <DialogContent
        aria-describedby="intro-video-wizard-description"
        className="zero-app flex h-[min(88vh,820px)] w-[calc(100vw-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 [&>button]:right-4 [&>button]:top-4"
      >
        <WizardHeader busy={busy} source={source} step={step} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-5 py-6 sm:px-6">
          <WizardContent
            busy={busy}
            composer={composer}
            countdown={countdown}
            recordingSeconds={recordingSeconds}
            source={source}
            sourcePersisted={sourcePersisted}
            step={step}
          />
        </div>
        <WizardFooter
          busy={busy}
          error={error}
          source={source}
          sourcePersisted={sourcePersisted}
          step={step}
          voice={voice}
          composer={composer}
        />
      </DialogContent>
    </Dialog>
  );
}
