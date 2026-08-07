import { useGet, useSet } from "ccstate-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Switch } from "@vm0/ui/components/ui/switch";
import type {
  GenerationTemplateRequest,
  VideoGenerationOptions,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_CONFIGS,
  VIDEO_MODELS,
  resolveVideoGenerationOptions,
  type ResolvedVideoGenerationOptions,
  type VideoModel,
  type VideoModelConfig,
} from "@vm0/core/video-model-catalog";
import { useTranslation } from "react-i18next";
import type { ComposerSignals } from "../../signals/zero-page/composer-signals.ts";

/**
 * Only the values the user actually chose are persisted, so a template written
 * today follows a later change of default instead of pinning the current one.
 */
function toVideoOptionsPatch(
  next: ResolvedVideoGenerationOptions,
  modelDefaults: ResolvedVideoGenerationOptions,
): VideoGenerationOptions {
  return {
    ...(next.model === DEFAULT_VIDEO_MODEL ? {} : { model: next.model }),
    ...(next.aspectRatio === modelDefaults.aspectRatio
      ? {}
      : { aspectRatio: next.aspectRatio }),
    ...(next.duration === modelDefaults.duration
      ? {}
      : { duration: next.duration }),
    ...(next.resolution === modelDefaults.resolution
      ? {}
      : { resolution: next.resolution }),
    ...(next.generateAudio === modelDefaults.generateAudio
      ? {}
      : { generateAudio: next.generateAudio }),
  };
}

/** Narrows a Select's string payload back to the catalog's literal union. */
function pickValue<T extends string>(
  values: readonly T[],
  next: string,
): T | undefined {
  return values.find((value) => {
    return value === next;
  });
}

function VideoOptionRow({
  label,
  value,
  values,
  onChange,
  onMenuToggle,
}: {
  readonly label: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly onChange: (next: string) => void;
  readonly onMenuToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select
        value={value}
        onValueChange={onChange}
        onOpenChange={onMenuToggle}
      >
        <SelectTrigger className="h-8 w-[9.5rem]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((option) => {
            return (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function VideoModelRow({
  label,
  model,
  onChange,
  onMenuToggle,
}: {
  readonly label: string;
  readonly model: VideoModel;
  readonly onChange: (next: string) => void;
  readonly onMenuToggle: () => void;
}) {
  const models = VIDEO_MODELS.filter((candidate) => {
    return VIDEO_MODEL_CONFIGS[candidate].public;
  });
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select
        value={model}
        onValueChange={onChange}
        onOpenChange={onMenuToggle}
      >
        <SelectTrigger className="h-8 w-[9.5rem]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((candidate) => {
            return (
              <SelectItem key={candidate} value={candidate}>
                {VIDEO_MODEL_CONFIGS[candidate].label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function VideoTemplateOptionsForm({
  value,
  onChange,
  onMenuToggle,
}: {
  readonly value: GenerationTemplateRequest;
  readonly onChange: (next: GenerationTemplateRequest) => void;
  readonly onMenuToggle: () => void;
}) {
  const { t } = useTranslation();
  if (value.type !== "video") {
    return null;
  }
  const resolved = resolveVideoGenerationOptions(value.selection.videoOptions);
  const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[resolved.model];
  const apply = (next: ResolvedVideoGenerationOptions): void => {
    // Re-resolve so a value the newly chosen model rejects falls back the same
    // way the generation service would.
    const settled = resolveVideoGenerationOptions(next);
    const modelDefaults = resolveVideoGenerationOptions({
      model: settled.model,
    });
    onChange({
      ...value,
      selection: {
        ...value.selection,
        videoOptions: toVideoOptionsPatch(settled, modelDefaults),
      },
    });
  };

  return (
    <div className="flex flex-col">
      <VideoModelRow
        label={t(($) => {
          return $.chat.templates.videoOptionsModel;
        })}
        model={resolved.model}
        onMenuToggle={onMenuToggle}
        onChange={(next) => {
          const model = pickValue(VIDEO_MODELS, next);
          if (model !== undefined) {
            apply({ ...resolved, model });
          }
        }}
      />
      <VideoOptionRow
        label={t(($) => {
          return $.chat.templates.videoOptionsRatio;
        })}
        value={resolved.aspectRatio}
        onMenuToggle={onMenuToggle}
        values={config.aspectRatios}
        onChange={(next) => {
          const aspectRatio = pickValue(config.aspectRatios, next);
          if (aspectRatio !== undefined) {
            apply({ ...resolved, aspectRatio });
          }
        }}
      />
      <VideoOptionRow
        label={t(($) => {
          return $.chat.templates.videoOptionsDuration;
        })}
        value={resolved.duration}
        onMenuToggle={onMenuToggle}
        values={config.durations}
        onChange={(next) => {
          const duration = pickValue(config.durations, next);
          if (duration !== undefined) {
            apply({ ...resolved, duration });
          }
        }}
      />
      <VideoOptionRow
        label={t(($) => {
          return $.chat.templates.videoOptionsResolution;
        })}
        value={resolved.resolution}
        onMenuToggle={onMenuToggle}
        values={config.resolutions}
        onChange={(next) => {
          const resolution = pickValue(config.resolutions, next);
          if (resolution !== undefined) {
            apply({ ...resolved, resolution });
          }
        }}
      />
      {config.supportsGenerateAudio && (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.templates.videoOptionsAudio;
            })}
          </span>
          <Switch
            checked={resolved.generateAudio}
            aria-label={t(($) => {
              return $.chat.templates.videoOptionsAudio;
            })}
            onCheckedChange={(checked) => {
              apply({ ...resolved, generateAudio: checked });
            }}
          />
        </div>
      )}
    </div>
  );
}

export function VideoTemplateOptionsPopover({
  signals,
  onChange,
}: {
  readonly signals: ComposerSignals;
  readonly onChange: (next: GenerationTemplateRequest) => void;
}) {
  const { t } = useTranslation();
  const anchor = useGet(signals.template.videoTemplateOptionsAnchor$);
  const value = useGet(signals.template.videoTemplateOptionsValue$);
  const source = useGet(signals.template.videoTemplateOptionsSource$);
  const close = useSet(signals.template.closeVideoTemplateOptions$);
  const setHover = useSet(signals.template.setVideoTemplateOptionsHover$);
  const pin = useSet(signals.template.pinVideoTemplateOptions$);

  if (!anchor || !value) {
    return null;
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={{
            left: `${String(anchor.left)}px`,
            top: `${String(anchor.top)}px`,
            width: `${String(anchor.width)}px`,
            height: `${String(anchor.height)}px`,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[19rem] rounded-xl p-3"
        aria-label={t(($) => {
          return $.chat.templates.videoOptions;
        })}
        // Merely pointing at a chip must not pull focus out of the composer.
        onOpenAutoFocus={(event) => {
          if (source === "hover") {
            event.preventDefault();
          }
        }}
        onMouseEnter={() => {
          setHover("popover", true);
        }}
        onMouseLeave={() => {
          setHover("popover", false);
        }}
      >
        <VideoTemplateOptionsForm
          value={value}
          onChange={onChange}
          onMenuToggle={pin}
        />
      </PopoverContent>
    </Popover>
  );
}
