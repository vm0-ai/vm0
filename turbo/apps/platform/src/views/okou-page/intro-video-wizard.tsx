import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from "react";
import {
  Ban,
  Check,
  ChevronDown,
  Clapperboard,
  File,
  LayoutTemplate,
  Loader2,
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
  SegmentControl,
  SegmentControlItem,
  Skeleton,
  Textarea,
  cn,
} from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "@okouai/ui/components/ui/sonner";
import { CHAT_UPLOAD_MAX_FILE_SIZE } from "../../lib/chat-upload.ts";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  introVideoAvatarPickerSignals,
  introVideoStylePickerSignals,
} from "../../signals/okou-page/intro-video-catalog-picker.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { groupIntroVideoAvatars } from "../../signals/okou-page/intro-video-avatar-groups.ts";
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
import { IntroVideoAvatarGroupCard } from "./intro-video-avatar-group-card.tsx";
import { IntroVideoCatalogPagination } from "./intro-video-catalog-pagination.tsx";
import { IntroVideoStyleGallery } from "./intro-video-style-gallery.tsx";

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
    if (file.size <= CHAT_UPLOAD_MAX_FILE_SIZE) {
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
  sources,
}: {
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
  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div>
      <input
        ref={setFileInputRef}
        type="file"
        multiple
        className="hidden"
        data-intro-video-file-input=""
        onChange={onFileChange}
      />
      <Button
        type="button"
        variant="outline"
        data-intro-video-dropzone=""
        className={cn(
          "h-auto w-full flex-col gap-3 whitespace-normal rounded-2xl border border-dashed border-border bg-muted/35 px-4 text-center hover:border-foreground/25 hover:bg-muted/50 sm:flex-row sm:gap-4 sm:px-5",
          sources.length === 0 ? "py-4 sm:py-5" : "py-3 sm:py-4",
        )}
        onClick={openFileInput}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={onDrop}
      >
        {sources.length === 0 ? (
          <span className="mx-auto grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-text sm:mx-0 sm:shrink-0">
            <Upload size={19} />
          </span>
        ) : null}
        <span className="text-sm font-semibold text-foreground">
          {t(($) => {
            return $.chat.introVideo.source.drop;
          })}
        </span>
      </Button>
      {sources.length > 0 ? (
        <div className="mt-3 grid gap-2" data-intro-video-file-list="">
          {sources.map((source) => {
            return (
              <div
                key={source.key}
                className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
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
                        removeSource(source.key, rootSignal),
                        Reason.DomCallback,
                        "remove intro video source",
                      );
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
                {source.origin === "uploaded" &&
                source.kind === "video" &&
                source.previewUrl ? (
                  <video
                    src={source.previewUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="block aspect-video max-h-64 w-full bg-black object-contain"
                    aria-label={t(
                      ($) => {
                        return $.artifacts.preview.videoLabel;
                      },
                      { filename: source.name },
                    )}
                  />
                ) : null}
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
      if (avatar.kind === "catalog") {
        return t(
          ($) => {
            return $.chat.introVideo.voice.defaultForAvatar;
          },
          { avatar: avatar.avatar.name },
        );
      }
      return avatar.kind === "none"
        ? t(($) => {
            return $.chat.introVideo.voice.auto;
          })
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
      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground sm:size-9">
        {icon}
      </span>
      <span className="w-full min-w-0 flex-1">
        <small className="block text-xs text-muted-foreground">{label}</small>
        <strong className="mt-0.5 line-clamp-2 text-sm font-medium leading-5 text-foreground">
          {value}
        </strong>
      </span>
      <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
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
        "relative flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3 pr-10 text-left transition-colors hover:border-foreground/20 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary" : "border-border",
      )}
      onClick={onSelect}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-brand-text">
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold text-foreground">
          {title}
        </strong>
        <small className="mt-0.5 block text-xs leading-5 text-muted-foreground">
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

function CatalogError({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <CatalogMessage>
      <div className="flex flex-col items-center gap-3" role="status">
        <span>
          {t(($) => {
            return $.chat.introVideo.catalog.error;
          })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => {
            return $.chat.introVideo.catalog.retry;
          })}
        </Button>
      </div>
    </CatalogMessage>
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
  const loadMoreState = useLoadable(introVideoStylePickerSignals.paging$);
  const loadMore = useSet(introVideoStylePickerSignals.loadMore$);
  const setSentinelRef = useSet(introVideoStylePickerSignals.setSentinelRef$);
  const reload = useSet(introVideoStylePickerSignals.reload$);
  const pageSignal = useGet(pageSignal$);
  const handleLoadMore = () => {
    detach(loadMore(pageSignal), Reason.DomCallback, "load more HeyGen styles");
  };
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
      <div className="grid gap-2">
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
      </div>
      {catalog.state === "hasError" ? (
        <CatalogError onRetry={reload} />
      ) : visible === undefined ? (
        <CatalogSkeleton />
      ) : visible.items.length === 0 ? (
        <CatalogMessage>
          {t(($) => {
            return $.chat.introVideo.catalog.empty;
          })}
        </CatalogMessage>
      ) : (
        <IntroVideoStyleGallery
          styles={visible.items}
          hasNext={visible.hasNext}
          selectedStyleId={
            selection.kind === "catalog" ? selection.style.id : undefined
          }
          onSelect={(style) => {
            choose({ kind: "catalog", style });
          }}
        />
      )}
      <IntroVideoCatalogPagination
        hasNext={visible?.hasNext ?? false}
        loading={loadMoreState.state === "loading"}
        error={loadMoreState.state === "hasError" ? loadMoreState.error : null}
        onLoadMore={handleLoadMore}
        onReload={reload}
        onSentinelRef={setSentinelRef}
      />
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
  const loadMoreState = useLoadable(introVideoAvatarPickerSignals.paging$);
  const loadMore = useSet(introVideoAvatarPickerSignals.loadMore$);
  const setSentinelRef = useSet(introVideoAvatarPickerSignals.setSentinelRef$);
  const reload = useSet(introVideoAvatarPickerSignals.reload$);
  const pageSignal = useGet(pageSignal$);
  const handleLoadMore = () => {
    detach(
      loadMore(pageSignal),
      Reason.DomCallback,
      "load more HeyGen avatars",
    );
  };
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
        <CatalogError onRetry={reload} />
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
          {groupIntroVideoAvatars(visible.items).map((group) => {
            return (
              <IntroVideoAvatarGroupCard
                key={group.id}
                group={group}
                selected={
                  selection.kind === "catalog" ? selection.avatar : undefined
                }
                onSelect={(avatar) => {
                  choose({ kind: "catalog", avatar });
                }}
              />
            );
          })}
        </div>
      )}
      <IntroVideoCatalogPagination
        hasNext={visible?.hasNext ?? false}
        loading={loadMoreState.state === "loading"}
        error={loadMoreState.state === "hasError" ? loadMoreState.error : null}
        onLoadMore={handleLoadMore}
        onReload={reload}
        onSentinelRef={setSentinelRef}
      />
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
    return source.kind === "video" || source.kind === "audio";
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
        <div className="grid w-full grid-cols-1 gap-2 sm:flex-1 sm:grid-cols-2 sm:gap-3">
          <UtilityOption
            title={t(($) => {
              return avatar.kind === "none"
                ? $.chat.introVideo.voice.auto
                : $.chat.introVideo.voice.default;
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
                : avatar.kind === "none"
                  ? t(($) => {
                      return $.chat.introVideo.voice.autoDescription;
                    })
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
        <div className="flex justify-end">
          <VoiceLibraryToolbar />
        </div>
      </div>
      <VoiceLibraryContent
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

function pickerTitle(t: TFunction<"common">, picker: IntroVideoPicker) {
  switch (picker) {
    case "style": {
      return t(($) => {
        return $.chat.introVideo.style.heading;
      });
    }
    case "avatar": {
      return t(($) => {
        return $.chat.introVideo.avatar.heading;
      });
    }
    case "voice": {
      return t(($) => {
        return $.chat.introVideo.voice.heading;
      });
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
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setPicker(null);
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="okou-app flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(82vh,720px)] sm:w-[calc(100vw-2rem)]"
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12 text-left sm:px-6 sm:py-4 sm:pr-14">
          <DialogTitle className="text-base font-semibold">
            {pickerTitle(t, picker)}
          </DialogTitle>
        </DialogHeader>
        <div
          data-intro-video-catalog-scroll=""
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6"
        >
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

function IntroVideoFormFields() {
  const { t } = useTranslation();
  const busy = useGet(introVideoWizardSignals.busy$);
  const sources = useGet(introVideoWizardSignals.sources$);
  const instructions = useGet(introVideoWizardSignals.instructions$);
  const style = useGet(introVideoWizardSignals.style$);
  const avatar = useGet(introVideoWizardSignals.avatar$);
  const voice = useGet(introVideoWizardSignals.voice$);
  const aspectRatio = useGet(introVideoWizardSignals.aspectRatio$);
  const setAspectRatio = useSet(introVideoWizardSignals.setAspectRatio$);
  const setInstructions = useSet(introVideoWizardSignals.setInstructions$);
  const setPicker = useSet(introVideoWizardSignals.setPicker$);
  return (
    <fieldset
      disabled={busy}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background px-4 py-4 sm:px-6 sm:py-6"
    >
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
          <FileDropzone sources={sources} />
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
        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
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
        <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <span id="intro-video-output-format" className="text-sm font-medium">
            {t(($) => {
              return $.chat.introVideo.format.output;
            })}
          </span>
          <SegmentControl
            value={aspectRatio}
            onValueChange={setAspectRatio}
            aria-labelledby="intro-video-output-format"
            className="w-full sm:w-auto"
          >
            <SegmentControlItem value="auto" className="flex-1">
              {t(($) => {
                return $.chat.introVideo.format.auto;
              })}
            </SegmentControlItem>
            <SegmentControlItem value="16:9" className="flex-1">
              16:9
            </SegmentControlItem>
            <SegmentControlItem value="9:16" className="flex-1">
              9:16
            </SegmentControlItem>
          </SegmentControl>
        </div>
      </div>
    </fieldset>
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
  const busy = useGet(introVideoWizardSignals.busy$);
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
          showCloseButton={!busy}
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
          <IntroVideoFormFields />
          <IntroVideoFooter composer={composer} />
        </DialogContent>
      </Dialog>
      <PickerDialog avatar={avatar} picker={picker} sources={sources} />
    </>
  );
}
