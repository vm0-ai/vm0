import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
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
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import type {
  ComposerImageModelSignals,
  ComposerSignals,
} from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ImageModelBrandIcon } from "./components/model-provider-picker.tsx";
import { ComposerTaskVideoSettings } from "./composer-video-options.tsx";

function ImageTaskModel({
  imageModel,
}: {
  readonly imageModel: ComposerImageModelSignals;
}) {
  const { t } = useTranslation();
  const model = useLastResolved(imageModel.effectiveImageModel$);
  const setModel = useSet(imageModel.setImageModel$);
  const pageSignal = useGet(pageSignal$);
  if (model === undefined) {
    return null;
  }
  return (
    <Select<ImageModel>
      value={model}
      onValueChange={(next) => {
        detach(setModel(next, pageSignal), Reason.DomCallback);
      }}
    >
      <SelectTrigger
        className="h-8 w-auto max-w-[8.5rem] gap-1.5 border-transparent bg-transparent px-2 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground sm:max-w-[14rem]"
        aria-label={t(($) => {
          return $.settings.models.picker.imageModels;
        })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="max-w-[calc(100vw-1.5rem)]"
      >
        {PUBLIC_IMAGE_MODELS.map((candidate) => {
          return (
            <SelectItem key={candidate} value={candidate}>
              <span className="flex min-w-0 items-center gap-2">
                <ImageModelBrandIcon model={candidate} />
                <span className="truncate">
                  {IMAGE_MODEL_CONFIGS[candidate].label}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function ComposerTaskModel({
  signals,
  fallback,
}: {
  readonly signals: ComposerSignals;
  readonly fallback: ReactNode;
}) {
  const task = useGet(signals.task.task$);
  if (task === "image" && signals.imageModel) {
    return <ImageTaskModel imageModel={signals.imageModel} />;
  }
  if (task === "video" && signals.videoModel) {
    return (
      <ComposerTaskVideoSettings
        signals={signals}
        videoModelSignals={signals.videoModel}
      />
    );
  }
  return fallback;
}
