import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from "react";
import type {
  IntroVideoAvatar,
  IntroVideoStyle,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import {
  Ban,
  Check,
  ChevronDown,
  Clapperboard,
  File,
  LayoutTemplate,
  Loader2,
  Play,
  Sparkles,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Textarea,
  cn,
} from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "@okouai/ui/components/ui/sonner";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  introVideoAvatarPickerSignals,
  introVideoStylePickerSignals,
} from "../../signals/okou-page/intro-video-catalog-picker.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  introVideoWizardSignals,
  type IntroVideoAvatarSelection,
  type IntroVideoPicker,
  type IntroVideoSource,
  type IntroVideoStyleSelection,
  type IntroVideoVoiceSelection,
  type IntroVideoWizardError,
} from "../../signals/okou-page/intro-video.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  VoiceLibraryContent,
  VoiceLibraryToolbar,
} from "./avatar-template-picker.tsx";

const MAX_FILE_SIZE = 1024 * 1024 * 1024;

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size.toString()} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.ceil(size / 1024).toString()} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function addableFiles(files: readonly File[], t: TFunction<"common">) {
  return files.filter((file) => {
    if (file.size <= MAX_FILE_SIZE) {
      return true;
    }
    toast.error(
      t(
        ($) => {
          return $.chat.attachments.fileTooLarge;
        },
        { filename: file.name },
      ),
    );
    return false;
  });
}

function FileDropzone({
  composer,
  sources,
}: {
  readonly composer: ComposerSignals;
  readonly sources: readonly IntroVideoSource[];
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const addSources = useSet(introVideoWizardSignals.addSourceFiles$);
  const openFileInput = useSet(introVideoWizardSignals.openFileInput$);
  const removeSource = useSet(introVideoWizardSignals.removeSource$);
  const setFileInputRef = useSet(introVideoWizardSignals.setFileInputRef$);
  const addFiles = (files: readonly File[]) => {
    addSources(addableFiles(files, t));
  };
  const onFileChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div>
      <div
        data-intro-video-dropzone=""
        className={cn(
          "rounded-2xl border border-dashed border-border bg-muted/35 px-4 text-center transition-colors hover:border-foreground/25 hover:bg-muted/50 sm:px-5",
          sources.length === 0 ? "py-4 sm:py-6" : "py-3 sm:py-4",
        )}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={onDrop}
      >
        <input
          ref={setFileInputRef}
          type="file"
          multiple
          className="hidden"
          data-intro-video-file-input=""
          onChange={onFileChange}
        />
        {sources.length === 0 ? (
          <span className="mx-auto grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-text">
            <Upload size={19} />
          </span>
        ) : null}
        <p
          className={cn(
            "text-sm font-semibold text-foreground",
            sources.length === 0 && "mt-3",
          )}
        >
          {t(($) => {
            return $.chat.introVideo.source.drop;
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 bg-background"
          onClick={openFileInput}
        >
          {t(($) => {
            return $.chat.introVideo.source.browse;
          })}
        </Button>
      </div>
      {sources.length > 0 ? (
        <div className="mt-3 grid gap-2" data-intro-video-file-list="">
          {sources.map((source) => {
            return (
              <div
                key={source.key}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-brand-text">
                  <File size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium text-foreground">
                    {source.name}
                  </strong>
                  <small className="mt-0.5 block text-xs text-muted-foreground">
                    {formatBytes(source.size)}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={t(
                    ($) => {
                      return $.chat.introVideo.source.remove;
                    },
                    { filename: source.name },
                  )}
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    detach(
                      removeSource(source.key, composer, rootSignal),
                      Reason.DomCallback,
                      "remove intro video source",
                    );
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function styleSelectionLabel(
  t: TFunction<"common">,
  selection: IntroVideoStyleSelection,
): string {
  switch (selection.kind) {
    case "auto": {
      return t(($) => {
        return $.chat.introVideo.style.auto;
      });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.style.none;
      });
    }
    case "catalog": {
      return selection.style.name;
    }
  }
}

function avatarSelectionLabel(
  t: TFunction<"common">,
  selection: IntroVideoAvatarSelection,
): string {
  switch (selection.kind) {
    case "auto": {
      return t(($) => {
        return $.chat.introVideo.avatar.auto;
      });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.avatar.none;
      });
    }
    case "catalog": {
      return selection.avatar.name;
    }
  }
}

function voiceSelectionLabel(
  t: TFunction<"common">,
  selection: IntroVideoVoiceSelection,
  avatar: IntroVideoAvatarSelection,
): string {
  switch (selection.kind) {
    case "default": {
      return avatar.kind === "catalog"
        ? t(
            ($) => {
              return $.chat.introVideo.voice.defaultForAvatar;
            },
            { avatar: avatar.avatar.name },
          )
        : t(($) => {
            return $.chat.introVideo.voice.default;
          });
    }
    case "none": {
      return t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    case "original": {
      return t(($) => {
        return $.chat.introVideo.voice.original;
      });
    }
    case "catalog": {
      return selection.voice.name;
    }
  }
}

function SettingTrigger({
  icon,
  label,
  value,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label}: ${value}`}
      title={`${label}: ${value}`}
      className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-border bg-card p-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-2.5"
      onClick={onClick}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground sm:size-9">
        {icon}
      </span>
      <span className="w-full min-w-0 flex-1">
        <small className="block text-[11px] text-muted-foreground">
          {label}
        </small>
        <strong className="mt-0.5 line-clamp-2 min-h-8 text-xs font-medium leading-4 text-foreground sm:block sm:min-h-0 sm:truncate sm:text-sm sm:leading-normal">
          {value}
        </strong>
      </span>
      <ChevronDown
        size={14}
        className="hidden shrink-0 text-muted-foreground sm:block"
      />
    </button>
  );
}

function UtilityOption({
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
      className={cn(
        "relative flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3 pr-10 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-28 sm:flex-col sm:gap-0 sm:pr-3",
        selected ? "border-primary" : "border-border",
      )}
      onClick={onSelect}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-brand-text">
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold text-foreground sm:mt-3">
          {title}
        </strong>
        <small className="mt-0.5 block text-xs leading-5 text-muted-foreground sm:mt-1">
          {description}
        </small>
      </span>
      {selected ? (
        <span className="absolute right-3 top-3 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={12} />
        </span>
      ) : null}
    </button>
  );
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="h-40 rounded-xl" />;
      })}
    </div>
  );
}

function CatalogMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function stylePreviewElement(video: HTMLVideoElement): HTMLElement | null {
  return video.closest<HTMLElement>("[data-intro-video-style-preview]");
}

function setStylePreviewLoading(
  video: HTMLVideoElement,
  loading: boolean,
): void {
  const preview = stylePreviewElement(video);
  if (preview) {
    preview.dataset.loading = String(loading);
  }
}

function setStylePreviewPlaying(
  video: HTMLVideoElement,
  playing: boolean,
): void {
  const preview = stylePreviewElement(video);
  if (preview) {
    preview.dataset.loading = "false";
    preview.dataset.previewPlaying = String(playing);
  }
}

function StyleCardMedia({ style }: { readonly style: IntroVideoStyle }) {
  return (
    <div className="aspect-video overflow-hidden bg-muted">
      {style.previewVideoUrl ? (
        <video
          src={style.previewVideoUrl}
          poster={style.thumbnailUrl}
          muted
          loop
          playsInline
          preload="none"
          className="h-full w-full object-cover"
          onWaiting={(event) => {
            setStylePreviewLoading(event.currentTarget, true);
          }}
          onPlaying={(event) => {
            setStylePreviewPlaying(event.currentTarget, true);
          }}
          onPause={(event) => {
            setStylePreviewPlaying(event.currentTarget, false);
          }}
          onError={(event) => {
            setStylePreviewPlaying(event.currentTarget, false);
          }}
        />
      ) : style.thumbnailUrl ? (
        <img
          src={style.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
        />
      ) : (
        <span className="grid h-full place-items-center text-muted-foreground">
          <LayoutTemplate size={28} />
        </span>
      )}
    </div>
  );
}

function StylePreviewControl({ style }: { readonly style: IntroVideoStyle }) {
  const { t } = useTranslation();
  if (!style.previewVideoUrl) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.artifacts.templates.playVideo;
        },
        { title: style.name },
      )}
      className="absolute inset-x-px top-px flex aspect-video items-center justify-center rounded-t-[11px] bg-black/10 text-white transition-colors hover:bg-black/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white group-data-[preview-playing=true]/style-preview:pointer-events-none group-data-[preview-playing=true]/style-preview:opacity-0"
      onClick={(event) => {
        const preview = event.currentTarget.closest<HTMLElement>(
          "[data-intro-video-style-preview]",
        );
        const video = preview?.querySelector("video");
        if (!video) {
          return;
        }
        video.defaultMuted = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        setStylePreviewLoading(video, true);
        detach(video.play(), Reason.DomCallback);
      }}
    >
      <span className="grid size-11 place-items-center rounded-full bg-black/55 shadow-lg group-data-[loading=true]/style-preview:hidden">
        <Play size={20} fill="currentColor" />
      </span>
      <span className="hidden size-11 place-items-center rounded-full bg-black/55 shadow-lg group-data-[loading=true]/style-preview:grid">
        <Loader2 size={20} className="animate-spin" />
      </span>
    </button>
  );
}

function StyleCard({
  selected,
  style,
  onSelect,
}: {
  readonly selected: boolean;
  readonly style: IntroVideoStyle;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-intro-video-style-preview=""
      data-preview-playing="false"
      data-loading="false"
      className="group/style-preview relative min-w-0 transition-transform hover:-translate-y-0.5"
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={t(
          ($) => {
            return $.artifacts.templates.selectStyle;
          },
          { style: style.name },
        )}
        className={cn(
          "group w-full min-w-0 overflow-hidden rounded-xl border bg-card text-left transition-all hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "border-primary" : "border-border",
        )}
        onClick={onSelect}
      >
        <StyleCardMedia style={style} />
        <div className="flex min-h-11 items-center gap-2 px-2.5 py-2 sm:min-h-12 sm:px-3 sm:py-2.5">
          <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {style.name}
          </strong>
          {selected ? (
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
              <Check size={12} />
            </span>
          ) : null}
        </div>
      </button>
      <StylePreviewControl style={style} />
    </div>
  );
}

function AvatarCard({
  avatar,
  selected,
  onSelect,
}: {
  readonly avatar: IntroVideoAvatar;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${t(($) => {
        return $.chat.introVideo.avatar.heading;
      })}: ${avatar.name}`}
      className={cn(
        "group relative min-w-0 overflow-hidden rounded-xl border bg-card text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary" : "border-border",
      )}
      onClick={onSelect}
    >
      <div className="aspect-[4/3] overflow-hidden bg-muted">
        {avatar.previewImageUrl ? (
          <img
            src={avatar.previewImageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <span className="grid h-full place-items-center text-muted-foreground">
            <UserRound size={32} />
          </span>
        )}
      </div>
      <div className="flex min-h-12 items-center gap-2 px-3 py-2.5">
        <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {avatar.name}
        </strong>
        {selected ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check size={12} />
          </span>
        ) : null}
      </div>
    </button>
  );
}

function StylePicker() {
  const { t } = useTranslation();
  const selection = useGet(introVideoWizardSignals.style$);
  const setSelection = useSet(introVideoWizardSignals.setStyle$);
  const close = useSet(introVideoWizardSignals.setPicker$);
  const catalog = useLoadable(introVideoStylePickerSignals.catalogPage$);
  const lastCatalog = useLastResolved(
    introVideoStylePickerSignals.catalogPage$,
  );
  const generation = useGet(introVideoStylePickerSignals.generation$);
  const loadMore = useSet(introVideoStylePickerSignals.loadMore$);
  const loadingMore = useGet(introVideoStylePickerSignals.loadingMore$);
  const pageSignal = useGet(pageSignal$);
  const visible =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const choose = (next: IntroVideoStyleSelection) => {
    setSelection(next);
    close(null);
  };
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        <UtilityOption
          title={t(($) => {
            return $.chat.introVideo.style.auto;
          })}
          description={t(($) => {
            return $.chat.introVideo.style.autoDescription;
          })}
          icon={<Sparkles size={17} />}
          selected={selection.kind === "auto"}
          onSelect={() => {
            choose({ kind: "auto" });
          }}
        />
        <UtilityOption
          title={t(($) => {
            return $.chat.introVideo.style.none;
          })}
          description={t(($) => {
            return $.chat.introVideo.style.noneDescription;
          })}
          icon={<Ban size={17} />}
          selected={selection.kind === "none"}
          onSelect={() => {
            choose({ kind: "none" });
          }}
        />
      </div>
      {catalog.state === "hasError" ? (
        <CatalogMessage>
          {t(($) => {
            return $.chat.introVideo.catalog.error;
          })}
        </CatalogMessage>
      ) : visible === undefined ? (
        <CatalogSkeleton />
      ) : visible.items.length === 0 ? (
        <CatalogMessage>
          {t(($) => {
            return $.chat.introVideo.catalog.empty;
          })}
        </CatalogMessage>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
          {visible.items.map((style) => {
            return (
              <StyleCard
                key={style.id}
                style={style}
                selected={
                  selection.kind === "catalog" &&
                  selection.style.id === style.id
                }
                onSelect={() => {
                  choose({ kind: "catalog", style });
                }}
              />
            );
          })}
        </div>
      )}
      {visible?.hasNext ? (
        <Button
          type="button"
          variant="outline"
          disabled={loadingMore}
          className="mx-auto"
          onClick={() => {
            detach(
              loadMore(pageSignal),
              Reason.DomCallback,
              "load more HeyGen styles",
            );
          }}
        >
          {loadingMore ? <Loader2 className="animate-spin" size={15} /> : null}
          {t(($) => {
            return $.chat.introVideo.catalog.loadMore;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function AvatarPicker() {
  const { t } = useTranslation();
  const selection = useGet(introVideoWizardSignals.avatar$);
  const setSelection = useSet(introVideoWizardSignals.setAvatar$);
  const close = useSet(introVideoWizardSignals.setPicker$);
  const catalog = useLoadable(introVideoAvatarPickerSignals.catalogPage$);
  const lastCatalog = useLastResolved(
    introVideoAvatarPickerSignals.catalogPage$,
  );
  const generation = useGet(introVideoAvatarPickerSignals.generation$);
  const loadMore = useSet(introVideoAvatarPickerSignals.loadMore$);
  const loadingMore = useGet(introVideoAvatarPickerSignals.loadingMore$);
  const pageSignal = useGet(pageSignal$);
  const visible =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const choose = (next: IntroVideoAvatarSelection) => {
    setSelection(next);
    close(null);
  };
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
        <UtilityOption
          title={t(($) => {
            return $.chat.introVideo.avatar.auto;
          })}
          description={t(($) => {
            return $.chat.introVideo.avatar.autoDescription;
          })}
          icon={<Sparkles size={17} />}
          selected={selection.kind === "auto"}
          onSelect={() => {
            choose({ kind: "auto" });
          }}
        />
        <UtilityOption
          title={t(($) => {
            return $.chat.introVideo.avatar.none;
          })}
          description={t(($) => {
            return $.chat.introVideo.avatar.noneDescription;
          })}
          icon={<Ban size={17} />}
          selected={selection.kind === "none"}
          onSelect={() => {
            choose({ kind: "none" });
          }}
        />
      </div>
      {catalog.state === "hasError" ? (
        <CatalogMessage>
          {t(($) => {
            return $.chat.introVideo.catalog.error;
          })}
        </CatalogMessage>
      ) : visible === undefined ? (
        <CatalogSkeleton />
      ) : visible.items.length === 0 ? (
        <CatalogMessage>
          {t(($) => {
            return $.chat.introVideo.catalog.empty;
          })}
        </CatalogMessage>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
          {visible.items.map((avatar) => {
            return (
              <AvatarCard
                key={avatar.id}
                avatar={avatar}
                selected={
                  selection.kind === "catalog" &&
                  selection.avatar.id === avatar.id
                }
                onSelect={() => {
                  choose({ kind: "catalog", avatar });
                }}
              />
            );
          })}
        </div>
      )}
      {visible?.hasNext ? (
        <Button
          type="button"
          variant="outline"
          disabled={loadingMore}
          className="mx-auto"
          onClick={() => {
            detach(
              loadMore(pageSignal),
              Reason.DomCallback,
              "load more HeyGen avatars",
            );
          }}
        >
          {loadingMore ? <Loader2 className="animate-spin" size={15} /> : null}
          {t(($) => {
            return $.chat.introVideo.catalog.loadMore;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function VoicePicker({
  avatar,
  sources,
}: {
  readonly avatar: IntroVideoAvatarSelection;
  readonly sources: readonly IntroVideoSource[];
}) {
  const { t } = useTranslation();
  const selection = useGet(introVideoWizardSignals.voice$);
  const setSelection = useSet(introVideoWizardSignals.setVoice$);
  const close = useSet(introVideoWizardSignals.setPicker$);
  const choose = (next: IntroVideoVoiceSelection) => {
    setSelection(next);
    close(null);
  };
  const originalAudioAvailable = sources.some((source) => {
    return source.kind === "video";
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
          <UtilityOption
            title={t(($) => {
              return $.chat.introVideo.voice.default;
            })}
            description={
              avatar.kind === "catalog"
                ? t(
                    ($) => {
                      return $.chat.introVideo.voice
                        .defaultForAvatarDescription;
                    },
                    { avatar: avatar.avatar.name },
                  )
                : t(($) => {
                    return $.chat.introVideo.voice.defaultDescription;
                  })
            }
            icon={<Sparkles size={17} />}
            selected={selection.kind === "default"}
            onSelect={() => {
              choose({ kind: "default" });
            }}
          />
          <UtilityOption
            title={t(($) => {
              return $.chat.introVideo.voice.none;
            })}
            description={t(($) => {
              return $.chat.introVideo.voice.noneDescription;
            })}
            icon={<VolumeX size={17} />}
            selected={selection.kind === "none"}
            onSelect={() => {
              choose({ kind: "none" });
            }}
          />
          {originalAudioAvailable ? (
            <UtilityOption
              title={t(($) => {
                return $.chat.introVideo.voice.original;
              })}
              description={t(($) => {
                return $.chat.introVideo.voice.originalDescription;
              })}
              icon={<Volume2 size={17} />}
              selected={selection.kind === "original"}
              onSelect={() => {
                choose({ kind: "original" });
              }}
            />
          ) : null}
        </div>
        <VoiceLibraryToolbar />
      </div>
      <VoiceLibraryContent
        selectionActive={selection.kind === "catalog"}
        selectedVoiceId={
          selection.kind === "catalog" ? selection.voice.id : undefined
        }
        onSelect={(voice) => {
          choose({ kind: "catalog", voice });
        }}
      />
    </div>
  );
}

function pickerCopy(t: TFunction<"common">, picker: IntroVideoPicker) {
  switch (picker) {
    case "style": {
      return {
        title: t(($) => {
          return $.chat.introVideo.style.heading;
        }),
        description: t(($) => {
          return $.chat.introVideo.style.help;
        }),
      };
    }
    case "avatar": {
      return {
        title: t(($) => {
          return $.chat.introVideo.avatar.heading;
        }),
        description: t(($) => {
          return $.chat.introVideo.avatar.help;
        }),
      };
    }
    case "voice": {
      return {
        title: t(($) => {
          return $.chat.introVideo.voice.heading;
        }),
        description: t(($) => {
          return $.chat.introVideo.voice.help;
        }),
      };
    }
  }
}

function PickerDialog({
  avatar,
  picker,
  sources,
}: {
  readonly avatar: IntroVideoAvatarSelection;
  readonly picker: IntroVideoPicker | null;
  readonly sources: readonly IntroVideoSource[];
}) {
  const { t } = useTranslation();
  const setPicker = useSet(introVideoWizardSignals.setPicker$);
  if (!picker) {
    return null;
  }
  const copy = pickerCopy(t, picker);
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setPicker(null);
        }
      }}
    >
      <DialogContent className="okou-app flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(82vh,720px)] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left sm:px-6 sm:py-4 sm:pr-14">
          <DialogTitle className="text-base font-semibold">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 sm:text-sm">
            {copy.description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6">
          {picker === "style" ? <StylePicker /> : null}
          {picker === "avatar" ? <AvatarPicker /> : null}
          {picker === "voice" ? (
            <VoicePicker avatar={avatar} sources={sources} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function errorCopy(
  t: TFunction<"common">,
  error: IntroVideoWizardError,
): string {
  return error === "upload-failed"
    ? t(($) => {
        return $.chat.introVideo.errors.uploadFailed;
      })
    : t(($) => {
        return $.chat.introVideo.errors.sendFailed;
      });
}

function IntroVideoFormFields({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const { t } = useTranslation();
  const sources = useGet(introVideoWizardSignals.sources$);
  const instructions = useGet(introVideoWizardSignals.instructions$);
  const style = useGet(introVideoWizardSignals.style$);
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const setInstructions = useSet(introVideoWizardSignals.setInstructions$);
  const setPicker = useSet(introVideoWizardSignals.setPicker$);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto w-full max-w-3xl">
        <h3 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
          {t(($) => {
            return $.chat.introVideo.heading;
          })}
        </h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.help;
          })}
        </p>
        <div className="mt-4 sm:mt-5">
          <FileDropzone composer={composer} sources={sources} />
        </div>
        <label className="mt-4 block sm:mt-5">
          <span className="mb-2 block text-sm font-medium text-foreground">
            {t(($) => {
              return $.chat.introVideo.prompt.label;
            })}
          </span>
          <Textarea
            value={instructions}
            rows={4}
            placeholder={t(($) => {
              return $.chat.introVideo.prompt.placeholder;
            })}
            className="resize-y bg-card leading-6"
            onChange={(event) => {
              setInstructions(event.currentTarget.value);
            }}
          />
        </label>
        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-2.5">
          <SettingTrigger
            label={t(($) => {
              return $.chat.introVideo.style.label;
            })}
            value={styleSelectionLabel(t, style)}
            icon={<LayoutTemplate size={16} />}
            onClick={() => {
              setPicker("style");
            }}
          />
          <SettingTrigger
            label={t(($) => {
              return $.chat.introVideo.avatar.label;
            })}
            value={avatarSelectionLabel(t, avatar)}
            icon={<UserRound size={16} />}
            onClick={() => {
              setPicker("avatar");
            }}
          />
          <SettingTrigger
            label={t(($) => {
              return $.chat.introVideo.voice.label;
            })}
            value={voiceSelectionLabel(t, voice, avatar)}
            icon={<Volume2 size={16} />}
            onClick={() => {
              setPicker("voice");
            }}
          />
        </div>
      </div>
    </div>
  );
}

function IntroVideoFooter({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const sources = useGet(introVideoWizardSignals.sources$);
  const instructions = useGet(introVideoWizardSignals.instructions$);
  const busy = useGet(introVideoWizardSignals.busy$);
  const error = useGet(introVideoWizardSignals.error$);
  const close = useSet(introVideoWizardSignals.closeWizard$);
  const submit = useSet(introVideoWizardSignals.submit$);
  const canSubmit = sources.length > 0 || instructions.trim().length > 0;
  return (
    <footer className="shrink-0 border-t border-border bg-card px-4 py-3 sm:px-6 sm:py-3.5">
      {error ? (
        <div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorCopy(t, error)}
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:block">
          {t(($) => {
            return $.chat.introVideo.footer.hint;
          })}
        </span>
        <Button
          type="button"
          variant="outline"
          className="flex-1 sm:flex-none"
          disabled={busy}
          onClick={close}
        >
          {t(($) => {
            return $.chat.introVideo.footer.cancel;
          })}
        </Button>
        <Button
          type="button"
          className="flex-1 sm:flex-none"
          disabled={busy || !canSubmit}
          onClick={() => {
            detach(
              submit(composer, rootSignal),
              Reason.DomCallback,
              "create intro video chat thread",
            );
          }}
        >
          {busy ? <Loader2 className="animate-spin" size={15} /> : null}
          {t(($) => {
            return $.chat.introVideo.footer.create;
          })}
        </Button>
      </div>
    </footer>
  );
}

export function IntroVideoWizard({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  const { t } = useTranslation();
  const open = useGet(introVideoWizardSignals.open$);
  const picker = useGet(introVideoWizardSignals.picker$);
  const sources = useGet(introVideoWizardSignals.sources$);
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const close = useSet(introVideoWizardSignals.closeWizard$);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            close();
          }
        }}
      >
        <DialogContent
          aria-describedby="intro-video-description"
          className="okou-app flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(88vh,760px)] sm:w-[calc(100vw-1.5rem)] [&>button]:right-3 [&>button]:top-3 sm:[&>button]:right-4 sm:[&>button]:top-4"
        >
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left sm:px-6 sm:py-4 sm:pr-14">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                <Clapperboard size={18} />
              </span>
              <DialogTitle className="text-base font-semibold">
                {t(($) => {
                  return $.chat.introVideo.title;
                })}
              </DialogTitle>
            </div>
            <DialogDescription id="intro-video-description" className="sr-only">
              {t(($) => {
                return $.chat.introVideo.description;
              })}
            </DialogDescription>
          </DialogHeader>
          <IntroVideoFormFields composer={composer} />
          <IntroVideoFooter composer={composer} />
        </DialogContent>
      </Dialog>
      <PickerDialog avatar={avatar} picker={picker} sources={sources} />
    </>
  );
}
