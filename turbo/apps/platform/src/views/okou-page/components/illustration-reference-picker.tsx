import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent as ReactFormEvent,
  ReactNode,
} from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  Crop,
  ImagePlus,
  Loader2,
  Lock,
  MoreHorizontal,
  RotateCw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@okouai/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui/components/ui/dropdown-menu";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { cn } from "@okouai/ui/lib/utils";

import type {
  IllustrationReferencePickerCatalog,
  IllustrationReferencePickerItem,
  IllustrationReferencePickerSignals,
  ImageReferencePickerUpdate,
} from "../../../signals/okou-page/illustration-reference-picker.ts";
import type {
  ImageReferenceImageSignals,
  ImageReferenceLoadedImage,
  ImageReferenceImageSlot,
} from "../../../signals/okou-page/image-reference-library.ts";
import type { ImageReferencePickerState } from "../../../signals/okou-page/image-reference-picker-state.ts";
import { IMAGE_REFERENCE_ACCEPT } from "../../../signals/okou-page/reference-image-canvas.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";

interface PickerMutationActions {
  readonly busy: boolean;
  readonly onUpdate: (id: string, update: ImageReferencePickerUpdate) => void;
  readonly onDelete: (id: string) => void;
}

function firstTransferredImage(transfer: DataTransfer): File | null {
  for (const item of transfer.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return (
    [...transfer.files].find((file) => {
      return file.type.startsWith("image/");
    }) ?? null
  );
}

const IMAGE_REFERENCE_IMAGE_SLOTS = ["a", "b"] as const;

function referenceImageForSlot(options: {
  readonly active: ImageReferenceLoadedImage | null;
  readonly candidate: ImageReferenceLoadedImage | null;
  readonly slot: ImageReferenceImageSlot;
}): ImageReferenceLoadedImage | null {
  if (options.active?.slot === options.slot) {
    return options.active;
  }
  return options.candidate?.slot === options.slot ? options.candidate : null;
}

function useReferenceImageCandidate(
  imageSignals: ImageReferenceImageSignals,
  desiredUrl: string | null,
): {
  readonly active: ImageReferenceLoadedImage | null;
  readonly candidate: ImageReferenceLoadedImage | null;
} {
  const state = useGet(imageSignals.state$);
  const active = desiredUrl === null ? null : state.active;
  const failed = state.failed.some((image) => {
    return image.desiredUrl === desiredUrl && image.sourceUrl === desiredUrl;
  });
  return {
    active,
    candidate:
      desiredUrl === null || active?.sourceUrl === desiredUrl || failed
        ? null
        : {
            desiredUrl,
            sourceUrl: desiredUrl,
            slot: active?.slot === "a" ? "b" : "a",
          },
  };
}

function ReferenceImagePreview({
  item,
  compact = false,
}: {
  item: IllustrationReferencePickerItem;
  compact?: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const imageSignals = compact ? item.cardImage : item.detailImage;
  const desiredUrl = useLastResolved(imageSignals.desiredUrl$) ?? null;
  const commitLoaded = useSet(imageSignals.commitLoadedImage$);
  const failLoad = useSet(imageSignals.failImageLoad$);
  const { active, candidate } = useReferenceImageCandidate(
    imageSignals,
    desiredUrl,
  );
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden bg-muted text-muted-foreground",
        compact ? "aspect-[4/3]" : "aspect-video min-h-64 max-h-[52vh]",
      )}
    >
      {IMAGE_REFERENCE_IMAGE_SLOTS.map((slot) => {
        const image = referenceImageForSlot({ active, candidate, slot });
        const visible =
          active?.slot === slot || (active === null && image !== null);
        return (
          <img
            key={`${slot}:${image?.desiredUrl ?? "empty"}`}
            src={image?.sourceUrl}
            alt={visible ? item.title : ""}
            aria-hidden={visible ? undefined : "true"}
            data-image-reference-slot={slot}
            data-active={active?.slot === slot ? "true" : "false"}
            loading={compact ? "lazy" : "eager"}
            decoding="async"
            draggable={false}
            className={cn(
              "absolute inset-0 size-full opacity-0",
              compact ? "object-cover" : "object-contain",
              visible ? "opacity-100" : "",
            )}
            onLoad={(event) => {
              if (image && event.currentTarget.isConnected) {
                detach(commitLoaded(image, pageSignal), Reason.DomCallback);
              }
            }}
            onError={(event) => {
              if (image && event.currentTarget.isConnected) {
                detach(failLoad(image, pageSignal), Reason.DomCallback);
              }
            }}
          />
        );
      })}
      {active === null && candidate === null ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ImagePlus aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

function ReferenceScopeLabel({
  item,
  organizationName,
}: {
  item: IllustrationReferencePickerItem;
  organizationName: string;
}) {
  const { t } = useTranslation();
  if (item.visibility === "private") {
    return (
      <span className="inline-flex items-center gap-1">
        <Lock size={12} aria-hidden="true" />
        {t(($) => {
          return $.artifacts.imageReferences.onlyYou;
        })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Users size={12} aria-hidden="true" />
      {t(
        ($) => {
          return $.artifacts.imageReferences.everyoneIn;
        },
        { organization: organizationName },
      )}
    </span>
  );
}

function ReferenceCardMenu({
  item,
  actions,
  onOpenDetail,
}: {
  item: IllustrationReferencePickerItem;
  actions: PickerMutationActions;
  onOpenDetail: () => void;
}) {
  const { t } = useTranslation();
  if (!item.canManage && !item.canUnshare) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t(
          ($) => {
            return $.artifacts.imageReferences.actionsFor;
          },
          { title: item.title },
        )}
        disabled={actions.busy}
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="quiet"
            className="absolute right-2 top-2 bg-background/90 shadow-sm backdrop-blur-sm data-popup-open:bg-state-hover"
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
        {item.canManage ? (
          <DropdownMenuItem onClick={onOpenDetail}>
            {t(($) => {
              return $.artifacts.imageReferences.rename;
            })}
          </DropdownMenuItem>
        ) : null}
        {item.canManage ? (
          <DropdownMenuItem
            onClick={() => {
              actions.onUpdate(item.id, {
                visibility:
                  item.visibility === "private" ? "public" : "private",
              });
            }}
          >
            {item.visibility === "private"
              ? t(($) => {
                  return $.artifacts.imageReferences.shareWithOrganization;
                })
              : t(($) => {
                  return $.artifacts.imageReferences.makePrivate;
                })}
          </DropdownMenuItem>
        ) : null}
        {item.canUnshare && !item.canManage ? (
          <DropdownMenuItem
            onClick={() => {
              actions.onUpdate(item.id, { visibility: "private" });
            }}
          >
            {t(($) => {
              return $.artifacts.imageReferences.removeFromOrganization;
            })}
          </DropdownMenuItem>
        ) : null}
        {item.canManage ? <DropdownMenuSeparator /> : null}
        {item.canManage ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => {
              actions.onDelete(item.id);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t(($) => {
              return $.chat.actions.delete;
            })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReferenceCard({
  item,
  organizationName,
  selected,
  actions,
  onOpenDetail,
  onUse,
}: {
  item: IllustrationReferencePickerItem;
  organizationName: string;
  selected: boolean;
  actions: PickerMutationActions;
  onOpenDetail: () => void;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      className={cn(
        "group relative min-w-0 overflow-hidden rounded-xl border bg-card transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none",
        selected
          ? "border-primary ring-[3px] ring-primary/15"
          : "border-border hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md motion-reduce:hover:translate-y-0",
      )}
    >
      <button
        type="button"
        className="block w-full overflow-hidden text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-primary/40"
        aria-label={t(
          ($) => {
            return $.artifacts.imageReferences.preview;
          },
          { title: item.title },
        )}
        onClick={onOpenDetail}
      >
        <ReferenceImagePreview item={item} compact />
      </button>
      <ReferenceCardMenu
        item={item}
        actions={actions}
        onOpenDetail={onOpenDetail}
      />
      <div className="space-y-2.5 p-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-foreground">
            {item.title}
          </h4>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
            {item.creatorName ? (
              <span className="truncate">
                {t(
                  ($) => {
                    return $.artifacts.imageReferences.sharedBy;
                  },
                  { name: item.creatorName },
                )}
              </span>
            ) : (
              <ReferenceScopeLabel
                item={item}
                organizationName={organizationName}
              />
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={selected ? "default" : "outline"}
          className="w-full"
          aria-pressed={selected}
          onClick={onUse}
        >
          {selected
            ? t(($) => {
                return $.artifacts.imageReferences.selected;
              })
            : t(($) => {
                return $.artifacts.imageReferences.useReference;
              })}
        </Button>
      </div>
    </article>
  );
}

function UploadReferenceTile({
  state,
  onOpen,
}: {
  state: ImageReferencePickerState;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const setTriggerRef = useSet(state.uploadTriggerRef$);
  return (
    <button
      ref={setTriggerRef}
      type="button"
      className="flex min-h-56 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30"
      onClick={onOpen}
    >
      <span className="rounded-full bg-background p-3 shadow-sm">
        <Upload aria-hidden="true" />
      </span>
      <span className="text-sm font-semibold text-foreground">
        {t(($) => {
          return $.artifacts.imageReferences.uploadReference;
        })}
      </span>
      <span className="max-w-44 text-xs leading-5">
        {t(($) => {
          return $.artifacts.imageReferences.uploadHint;
        })}
      </span>
    </button>
  );
}

function ReferenceGroup({
  title,
  description,
  items,
  organizationName,
  selectedReferenceId,
  actions,
  uploadTile,
  onOpenDetail,
  onUse,
}: {
  title: string;
  description: string;
  items: readonly IllustrationReferencePickerItem[];
  organizationName: string;
  selectedReferenceId: string | null;
  actions: PickerMutationActions;
  uploadTile?: ReactNode;
  onOpenDetail: (id: string) => void;
  onUse: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={title} className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {uploadTile}
        {items.map((item) => {
          return (
            <ReferenceCard
              key={item.id}
              item={item}
              organizationName={organizationName}
              selected={selectedReferenceId === item.id}
              actions={actions}
              onOpenDetail={() => {
                onOpenDetail(item.id);
              }}
              onUse={() => {
                onUse(item.id);
              }}
            />
          );
        })}
      </div>
      {!uploadTile && items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t(($) => {
            return $.artifacts.imageReferences.organizationEmpty;
          })}
        </p>
      ) : null}
    </section>
  );
}

function UploadDropzone({ state }: { state: ImageReferencePickerState }) {
  const { t } = useTranslation();
  const chooseFile = useSet(state.chooseUploadFile$);
  const selectFile = useSet(state.selectUploadFile$);
  const setFileInputRef = useSet(state.fileInputRef$);
  const validationError = useGet(state.fileValidationError$);
  const acceptTransfer = (transfer: DataTransfer) => {
    const file = firstTransferredImage(transfer);
    if (file) {
      selectFile(file);
    }
  };
  return (
    <div
      className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center transition-colors focus-within:border-primary/60"
      onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault();
      }}
      onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault();
        acceptTransfer(event.dataTransfer);
      }}
      onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
        acceptTransfer(event.clipboardData);
      }}
    >
      <input
        ref={setFileInputRef}
        type="file"
        accept={IMAGE_REFERENCE_ACCEPT}
        className="sr-only"
        aria-label={t(($) => {
          return $.artifacts.imageReferences.chooseImage;
        })}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            selectFile(file);
          }
        }}
      />
      <span className="rounded-full bg-background p-4 text-foreground shadow-sm">
        <ImagePlus size={28} aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-foreground">
        {t(($) => {
          return $.artifacts.imageReferences.dropImage;
        })}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.imageReferences.formatHint;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-5"
        onClick={chooseFile}
      >
        {t(($) => {
          return $.artifacts.imageReferences.chooseImage;
        })}
      </Button>
      {validationError ? (
        <p
          role="alert"
          className="mt-4 flex items-center gap-2 text-sm text-destructive"
        >
          <AlertCircle size={16} aria-hidden="true" />
          {validationError === "size"
            ? t(($) => {
                return $.artifacts.imageReferences.errors.size;
              })
            : t(($) => {
                return $.artifacts.imageReferences.errors.format;
              })}
        </p>
      ) : null}
    </div>
  );
}

function ReferenceReviewControls({
  state,
}: {
  state: ImageReferencePickerState;
}) {
  const { t } = useTranslation();
  const draft = useGet(state.uploadDraft$);
  const setCropEnabled = useSet(state.setCropEnabled$);
  const updateCrop = useSet(state.updateCrop$);
  const rotate = useSet(state.rotateClockwise$);
  const reset = useSet(state.resetReview$);
  if (!draft) {
    return null;
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={rotate}>
          <RotateCw aria-hidden="true" />
          {t(($) => {
            return $.artifacts.imageReferences.rotate;
          })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={draft.cropEnabled ? "default" : "outline"}
          aria-pressed={draft.cropEnabled}
          onClick={() => {
            setCropEnabled(!draft.cropEnabled);
          }}
        >
          <Crop aria-hidden="true" />
          {t(($) => {
            return $.artifacts.imageReferences.crop;
          })}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={reset}>
          {t(($) => {
            return $.artifacts.imageReferences.reset;
          })}
        </Button>
      </div>
      {draft.cropEnabled ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {t(($) => {
              return $.artifacts.imageReferences.zoom;
            })}
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={draft.crop.zoom}
              onChange={(event) => {
                updateCrop({ zoom: event.currentTarget.valueAsNumber });
              }}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {t(($) => {
              return $.artifacts.imageReferences.horizontalPosition;
            })}
            <input
              type="range"
              min="0"
              max="100"
              value={draft.crop.x}
              onChange={(event) => {
                updateCrop({ x: event.currentTarget.valueAsNumber });
              }}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {t(($) => {
              return $.artifacts.imageReferences.verticalPosition;
            })}
            <input
              type="range"
              min="0"
              max="100"
              value={draft.crop.y}
              onChange={(event) => {
                updateCrop({ y: event.currentTarget.valueAsNumber });
              }}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function UploadReviewForm({ state }: { state: ImageReferencePickerState }) {
  const { t } = useTranslation();
  const draft = useGet(state.uploadDraft$);
  const setTitle = useSet(state.setUploadTitle$);
  const setVisibility = useSet(state.setUploadVisibility$);
  const chooseFile = useSet(state.chooseUploadFile$);
  if (!draft) {
    return null;
  }
  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-h-0 space-y-3">
        <div className="flex max-h-[45vh] min-h-56 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30">
          <img
            src={draft.previewUrl}
            alt={draft.title}
            className="max-h-[45vh] max-w-full object-contain transition-transform duration-200 motion-reduce:transition-none"
            style={{
              transform: `rotate(${draft.quarterTurns * 90}deg) scale(${draft.cropEnabled ? draft.crop.zoom : 1})`,
              transformOrigin: `${draft.crop.x}% ${draft.crop.y}%`,
            }}
          />
        </div>
        <ReferenceReviewControls state={state} />
      </div>
      <div className="space-y-5">
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          {t(($) => {
            return $.artifacts.imageReferences.name;
          })}
          <Input
            value={draft.title}
            required
            maxLength={80}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          {t(($) => {
            return $.workflows.detail.metadata.visibility;
          })}
          <Select
            value={draft.visibility}
            onValueChange={(value) => {
              setVisibility(value);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">
                {t(($) => {
                  return $.artifacts.imageReferences.onlyYou;
                })}
              </SelectItem>
              <SelectItem value="public">
                {t(($) => {
                  return $.artifacts.imageReferences.organizationVisibility;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>
        <p className="rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.artifacts.imageReferences.rightsReminder;
          })}
        </p>
        <Button type="button" variant="quiet" size="sm" onClick={chooseFile}>
          {t(($) => {
            return $.artifacts.imageReferences.chooseDifferentImage;
          })}
        </Button>
      </div>
    </div>
  );
}

function UploadProgress({ state }: { state: ImageReferencePickerState }) {
  const { t } = useTranslation();
  const uploadState = useGet(state.uploadState$);
  if (uploadState.status === "idle") {
    return null;
  }
  if (uploadState.status === "failed") {
    return (
      <p
        role="alert"
        className="flex items-center gap-2 text-sm text-destructive"
      >
        <AlertCircle size={16} aria-hidden="true" />
        {t(($) => {
          return $.artifacts.imageReferences.errors.upload;
        })}
      </p>
    );
  }
  const status =
    uploadState.status === "processing"
      ? t(($) => {
          return $.artifacts.imageReferences.processing;
        })
      : t(($) => {
          return $.artifacts.imageReferences.uploading;
        });
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {status}
      </p>
      <div
        role="progressbar"
        aria-label={status}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full w-1/2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function ReferenceUploadDialog({
  signals,
}: {
  signals: IllustrationReferencePickerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const open = useGet(signals.state.uploadDialogOpen$);
  const draft = useGet(signals.state.uploadDraft$);
  const uploadState = useGet(signals.state.uploadState$);
  const setOpen = useSet(signals.state.setUploadDialogOpen$);
  const cancel = useSet(signals.state.cancelUpload$);
  const restoreFocus = useSet(signals.state.restoreUploadTriggerFocus$);
  const lifecycleRef = useSet(signals.state.uploadDialogLifecycleRef$);
  const [createLoadable, create] = useLoadableSet(signals.createReference$);
  const busy = createLoadable.state === "loading";
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          restoreFocus();
        }
      }}
    >
      <DialogContent
        ref={lifecycleRef}
        maxWidth="5xl"
        contentClassName="overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.artifacts.imageReferences.uploadTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.artifacts.imageReferences.uploadDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {draft ? (
          <UploadReviewForm state={signals.state} />
        ) : (
          <UploadDropzone state={signals.state} />
        )}
        <UploadProgress state={signals.state} />
        <DialogFooter>
          {busy ? (
            <Button type="button" variant="outline" onClick={cancel}>
              {t(($) => {
                return $.artifacts.imageReferences.cancelUpload;
              })}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={!draft || draft.title.trim().length === 0 || busy}
            onClick={() => {
              detach(create(pageSignal), Reason.DomCallback);
            }}
          >
            {busy ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {uploadState.status === "failed"
              ? t(($) => {
                  return $.artifacts.imageReferences.retry;
                })
              : t(($) => {
                  return $.artifacts.imageReferences.saveReference;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReferenceRenameForm({
  item,
  busy,
  onRename,
}: {
  item: IllustrationReferencePickerItem;
  busy: boolean;
  onRename: (title: string) => void;
}) {
  const { t } = useTranslation();
  if (!item.canManage) {
    return (
      <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
    );
  }
  return (
    <form
      key={`${item.id}:${item.title}`}
      className="flex items-center gap-2"
      onSubmit={(event: ReactFormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const title = new FormData(event.currentTarget).get("title");
        if (
          typeof title === "string" &&
          title.trim() &&
          title.trim() !== item.title
        ) {
          onRename(title.trim().slice(0, 80));
        }
      }}
    >
      <Input
        name="title"
        defaultValue={item.title}
        maxLength={80}
        required
        aria-label={t(($) => {
          return $.artifacts.imageReferences.name;
        })}
      />
      <Button type="submit" size="sm" disabled={busy}>
        {t(($) => {
          return $.artifacts.imageReferences.save;
        })}
      </Button>
    </form>
  );
}

function ReferenceDetailManagement({
  item,
  organizationName,
  actions,
}: {
  item: IllustrationReferencePickerItem;
  organizationName: string;
  actions: PickerMutationActions;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <ReferenceRenameForm
        item={item}
        busy={actions.busy}
        onRename={(title) => {
          actions.onUpdate(item.id, { title });
        }}
      />
      <p className="text-sm text-muted-foreground">
        <ReferenceScopeLabel item={item} organizationName={organizationName} />
      </p>
      {item.canManage ? (
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          {t(($) => {
            return $.workflows.detail.metadata.visibility;
          })}
          <Select
            value={item.visibility}
            disabled={actions.busy}
            onValueChange={(visibility) => {
              actions.onUpdate(item.id, { visibility });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">
                {t(($) => {
                  return $.artifacts.imageReferences.onlyYou;
                })}
              </SelectItem>
              <SelectItem value="public">
                {t(($) => {
                  return $.artifacts.imageReferences.organizationVisibility;
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {item.canUnshare && !item.canManage ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions.busy}
          className="w-full"
          onClick={() => {
            actions.onUpdate(item.id, { visibility: "private" });
          }}
        >
          {t(($) => {
            return $.artifacts.imageReferences.removeFromOrganization;
          })}
        </Button>
      ) : null}
      {item.canManage ? (
        <Button
          type="button"
          variant="quiet"
          disabled={actions.busy}
          className="w-full text-destructive hover:text-destructive"
          onClick={() => {
            actions.onDelete(item.id);
          }}
        >
          <Trash2 aria-hidden="true" />
          {t(($) => {
            return $.artifacts.imageReferences.deleteReference;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function ReferenceDetailDialog({
  catalog,
  signals,
  actions,
  onUse,
}: {
  catalog: IllustrationReferencePickerCatalog;
  signals: IllustrationReferencePickerSignals;
  actions: PickerMutationActions;
  onUse: (id: string) => void;
}) {
  const { t } = useTranslation();
  const detailId = useGet(signals.state.detailReferenceId$);
  const setDetailId = useSet(signals.state.setDetailReferenceId$);
  const item = [...catalog.own, ...catalog.organization].find((candidate) => {
    return candidate.id === detailId;
  });
  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) {
          setDetailId(null);
        }
      }}
    >
      <DialogContent maxWidth="4xl" contentClassName="overflow-y-auto">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>{item.title}</DialogTitle>
              <DialogDescription>
                {t(($) => {
                  return $.artifacts.imageReferences.detailDescription;
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="overflow-hidden rounded-xl border border-border bg-muted/20">
                <ReferenceImagePreview item={item} />
              </div>
              <div>
                <ReferenceDetailManagement
                  item={item}
                  organizationName={catalog.organizationName}
                  actions={actions}
                />
                <Button
                  type="button"
                  className="mt-5 w-full"
                  onClick={() => {
                    onUse(item.id);
                  }}
                >
                  {t(($) => {
                    return $.artifacts.imageReferences.useReference;
                  })}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReferenceCatalogFailure({
  signals,
}: {
  signals: IllustrationReferencePickerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [refreshLoadable, refresh] = useLoadableSet(signals.refreshCatalog$);
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
      <p className="flex items-center gap-2 text-destructive">
        <AlertCircle aria-hidden="true" />
        {t(($) => {
          return $.artifacts.imageReferences.errors.load;
        })}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={refreshLoadable.state === "loading"}
        onClick={() => {
          detach(refresh(pageSignal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.artifacts.imageReferences.retry;
        })}
      </Button>
    </div>
  );
}

export function IllustrationReferencePicker({
  signals,
  builtInStyles,
  selectedReferenceId,
  onSelectReference,
}: {
  signals: IllustrationReferencePickerSignals;
  builtInStyles: ReactNode;
  selectedReferenceId: string | null;
  onSelectReference: (referenceId: string) => void;
}) {
  const { t } = useTranslation();
  const catalogLoadable = useLoadable(signals.catalog$);
  const catalog = useLastResolved(signals.catalog$);
  const setUploadOpen = useSet(signals.state.setUploadDialogOpen$);
  const setDetailId = useSet(signals.state.setDetailReferenceId$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, update] = useLoadableSet(signals.updateReference$);
  const [deleteLoadable, deleteReference] = useLoadableSet(
    signals.deleteReference$,
  );
  const busy =
    updateLoadable.state === "loading" || deleteLoadable.state === "loading";
  const actions: PickerMutationActions = {
    busy,
    onUpdate(id, body) {
      detach(update(id, body, pageSignal), Reason.DomCallback);
    },
    onDelete(id) {
      detach(deleteReference(id, pageSignal), Reason.DomCallback);
    },
  };
  const useReference = (id: string) => {
    onSelectReference(id);
    setDetailId(null);
  };
  return (
    <div className="space-y-8">
      {catalog ? (
        <>
          <ReferenceGroup
            title={t(($) => {
              return $.artifacts.imageReferences.yourReferences;
            })}
            description={t(($) => {
              return $.artifacts.imageReferences.yourReferencesDescription;
            })}
            items={catalog.own}
            organizationName={catalog.organizationName}
            selectedReferenceId={selectedReferenceId}
            actions={actions}
            uploadTile={
              <UploadReferenceTile
                state={signals.state}
                onOpen={() => {
                  setUploadOpen(true);
                }}
              />
            }
            onOpenDetail={setDetailId}
            onUse={useReference}
          />
          <ReferenceGroup
            title={t(($) => {
              return $.artifacts.imageReferences.organizationReferences;
            })}
            description={t(
              ($) => {
                return $.artifacts.imageReferences
                  .organizationReferencesDescription;
              },
              { organization: catalog.organizationName },
            )}
            items={catalog.organization}
            organizationName={catalog.organizationName}
            selectedReferenceId={selectedReferenceId}
            actions={actions}
            onOpenDetail={setDetailId}
            onUse={useReference}
          />
          <ReferenceDetailDialog
            catalog={catalog}
            signals={signals}
            actions={actions}
            onUse={useReference}
          />
        </>
      ) : catalogLoadable.state === "hasError" ? (
        <ReferenceCatalogFailure signals={signals} />
      ) : (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-busy="true"
        >
          {[0, 1, 2].map((index) => {
            return (
              <div
                key={index}
                className="h-56 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
              />
            );
          })}
        </div>
      )}
      <section
        aria-label={t(($) => {
          return $.artifacts.imageReferences.builtInStyles;
        })}
        className="space-y-3"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t(($) => {
              return $.artifacts.imageReferences.builtInStyles;
            })}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(($) => {
              return $.artifacts.imageReferences.builtInStylesDescription;
            })}
          </p>
        </div>
        {builtInStyles}
      </section>
      <ReferenceUploadDialog signals={signals} />
    </div>
  );
}
