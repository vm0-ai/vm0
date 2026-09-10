import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { resolveVideoRunOptions } from "../../signals/okou-page/video-run-options.ts";
import { Button } from "@okouai/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/core/image-model-catalog";
import {
  VIDEO_MODEL_CONFIGS,
  PUBLIC_VIDEO_MODELS,
} from "@okouai/core/video-model-catalog";
import type {
  ComposerSignals,
  ComposerImageModelSignals,
  ComposerVideoModelSignals,
} from "../../signals/okou-page/composer-signals.ts";
import {
  composerCreateModeLabel,
  composerCreateModeName,
  type ComposerCreateMode,
} from "../../signals/okou-page/composer-create.ts";
import { cn } from "@okouai/ui/lib/utils";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { COMPOSER_CREATE_ICONS } from "./slash-workflow.tsx";
import {
  ImageModelBrandIcon,
  VideoModelBrandIcon,
} from "./components/model-provider-picker.tsx";

const CREATE_CONTROL_FOCUS =
  "focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0";

const CREATE_MODE_ICON_CLASS = {
  presentation: "text-artifact-presentation",
  video: "text-artifact-video",
  image: "text-artifact-image",
} satisfies Record<ComposerCreateMode, string>;

export function ComposerCreateControls({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const mode = useGet(signals.create.mode$);
  if (!mode) {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <div className="@container/create-controls">
      <div className="flex min-h-11 min-w-0 items-center gap-1 px-2 pb-3 @max-[350px]/create-controls:px-3">
        <ComposerCreateChip signals={signals} mode={mode} />
      </div>
    </div>,
  );
}

function ComposerCreateChip({
  signals,
  mode,
}: {
  readonly signals: ComposerSignals;
  readonly mode: ComposerCreateMode;
}) {
  const { t } = useTranslation();
  const setMode = useSet(signals.create.setMode$);
  const Icon = COMPOSER_CREATE_ICONS[mode];
  return (
    <div
      className="group/create-mode flex h-8 max-w-full items-center rounded-lg bg-gray-50 @max-[350px]/create-controls:-ml-1"
      data-testid="composer-create-mode"
    >
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        className={cn("group relative shrink-0", CREATE_CONTROL_FOCUS)}
        aria-label={t(($) => {
          return $.chat.composer.create.exit;
        })}
        onClick={() => {
          setMode(null);
        }}
      >
        <Icon
          className={cn(
            "transition-opacity group-hover/create-mode:opacity-0 group-focus-visible:opacity-0 [@media(hover:none)]:opacity-0",
            CREATE_MODE_ICON_CLASS[mode],
          )}
          aria-hidden
        />
        <X
          className="absolute opacity-0 transition-opacity group-hover/create-mode:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          aria-hidden
        />
      </Button>
      <Select value={mode} onValueChange={setMode} modal={false}>
        <SelectTrigger
          className="h-8 w-auto min-w-0 gap-2 border-0 bg-transparent py-0 pl-0 pr-2.5 font-normal hover:bg-state-hover focus-visible:bg-state-hover"
          aria-label={t(($) => {
            return $.chat.composer.create.chooseType;
          })}
        >
          <SelectValue>{composerCreateModeLabel(mode)}</SelectValue>
        </SelectTrigger>
        <SelectContent
          align="start"
          alignOffset={-32}
          finalFocus={() => {
            return signals.editor.editor.view.dom;
          }}
        >
          {signals.create.modes.map((type) => {
            const TypeIcon = COMPOSER_CREATE_ICONS[type];
            return (
              <SelectItem key={type} value={type}>
                <span className="flex items-center gap-2">
                  <TypeIcon
                    className={cn("size-4", CREATE_MODE_ICON_CLASS[type])}
                    aria-hidden
                  />
                  {composerCreateModeName(type)}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function MediaModelSelect<Model extends string>({
  value,
  models,
  label,
  modelLabel,
  modelIcon,
  onChange,
}: {
  readonly value: Model;
  readonly models: readonly Model[];
  readonly label: string;
  readonly modelLabel: (model: Model) => string;
  readonly modelIcon: (model: Model) => ReactNode;
  readonly onChange: (model: Model) => void;
}) {
  return (
    // Keep adjacent composer actions tappable while the model menu is open.
    <Select value={value} onValueChange={onChange} modal={false}>
      <SelectTrigger
        aria-label={label}
        className="h-8 w-8 shrink-0 gap-1 border-transparent bg-transparent px-0 text-sm text-muted-foreground hover:bg-state-hover @min-[600px]/composer:w-auto @min-[600px]/composer:max-w-[11rem] @min-[600px]/composer:px-2 [&>[data-slot=select-icon]]:hidden @min-[600px]/composer:[&>[data-slot=select-icon]]:block"
      >
        <SelectValue>
          <span className="flex min-w-0 items-center justify-center gap-1.5 @min-[600px]/composer:justify-start">
            {modelIcon(value)}
            <span className="hidden truncate @min-[600px]/composer:block">
              {modelLabel(value)}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="end">
        {models.map((model) => {
          return (
            <SelectItem key={model} value={model}>
              <span className="flex items-center gap-2">
                {modelIcon(model)}
                {modelLabel(model)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function ComposerCreateImageModelPicker({
  model,
}: {
  readonly model: ComposerImageModelSignals;
}) {
  const { t } = useTranslation();
  const value = useLastResolved(model.effectiveImageModel$);
  const setModel = useSet(model.setImageModel$);
  const signal = useGet(pageSignal$);
  if (!value) {
    return null;
  }
  return (
    <MediaModelSelect
      value={value}
      models={PUBLIC_IMAGE_MODELS}
      label={t(($) => {
        return $.settings.models.picker.imageModels;
      })}
      modelLabel={(item) => {
        return IMAGE_MODEL_CONFIGS[item].label;
      }}
      modelIcon={(item) => {
        return <ImageModelBrandIcon model={item} />;
      }}
      onChange={(next) => {
        detach(setModel(next, signal), Reason.DomCallback);
      }}
    />
  );
}

export function ComposerCreateVideoModelPicker({
  model,
  signals,
}: {
  readonly model: ComposerVideoModelSignals;
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const value = useLastResolved(model.effectiveVideoModel$);
  const setModel = useSet(model.setVideoModel$);
  const patch = useGet(signals.videoOptions.videoRunOptions$);
  const signal = useGet(pageSignal$);
  if (!value) {
    return null;
  }
  return (
    <MediaModelSelect
      value={value}
      models={PUBLIC_VIDEO_MODELS}
      label={t(($) => {
        return $.settings.models.picker.videoModels;
      })}
      modelLabel={(item) => {
        return VIDEO_MODEL_CONFIGS[item].label;
      }}
      modelIcon={(item) => {
        return <VideoModelBrandIcon model={item} />;
      }}
      onChange={(next) => {
        detach(
          (async () => {
            await setModel(next, signal);
            signal.throwIfAborted();
            const resolved = resolveVideoRunOptions(patch, next);
            const adjusted =
              (patch.aspectRatio !== undefined &&
                patch.aspectRatio !== resolved.aspectRatio) ||
              (patch.resolution !== undefined &&
                patch.resolution !== resolved.resolution) ||
              (patch.duration !== undefined &&
                patch.duration !== resolved.duration) ||
              (patch.generateAudio !== undefined &&
                patch.generateAudio !== resolved.generateAudio);
            if (adjusted) {
              toast.info(
                t(($) => {
                  return $.chat.composer.create.settingsAdjusted;
                }),
              );
            }
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}
