import { useGet, useSet } from "ccstate-react";
import { Check } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui/components/ui/popover";
import { Switch } from "@vm0/ui/components/ui/switch";
import { cn } from "@vm0/ui";
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

const PUBLIC_VIDEO_MODELS = VIDEO_MODELS.filter((candidate) => {
  return VIDEO_MODEL_CONFIGS[candidate].public;
});

/**
 * A value chip. Selected uses the brand tint rather than a solid fill so a row
 * of six reads as one group instead of six competing buttons.
 */
function OptionChip({
  label,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "h-7 rounded-md px-2 text-[13px] leading-none transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        selected
          ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/30"
          : "text-muted-foreground hover:bg-gray-50 hover:text-foreground dark:hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

/**
 * One setting, fully expanded. Models disagree on how many values they take —
 * three durations for one, twenty-seven for another — so the row adapts instead
 * of forcing every setting through a dropdown: a single accepted value is read
 * only, and everything else wraps as chips the user can hit in one click.
 */
function VideoOptionField({
  label,
  value,
  values,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  if (values.length <= 1) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <span className="text-[13px] text-foreground">{value}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 py-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div
        className="flex flex-wrap gap-1"
        role="radiogroup"
        aria-label={label}
      >
        {values.map((option) => {
          return (
            <OptionChip
              key={option}
              label={option}
              selected={option === value}
              onSelect={() => {
                onChange(option);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * What a model gives you, in the terms the settings pane uses. Shown next to
 * every model so the trade-off between them is legible before switching rather
 * than after, which is the whole reason the model has its own popover.
 */
function videoModelSummary(
  config: VideoModelConfig,
  upTo: (duration: string) => string,
  audio: string,
): string {
  const longest = config.durations[config.durations.length - 1];
  return [
    longest === undefined ? undefined : upTo(longest),
    config.resolutions.join(", "),
    config.supportsGenerateAudio ? audio : undefined,
  ]
    .filter((segment) => {
      return segment !== undefined;
    })
    .join(" · ");
}

function VideoModelPane({
  model,
  onChange,
}: {
  readonly model: VideoModel;
  readonly onChange: (next: VideoModel) => void;
}) {
  const { t } = useTranslation();
  const audio = t(($) => {
    return $.chat.templates.videoSpecAudioOn;
  });
  return (
    <div className="flex flex-col" role="radiogroup">
      {PUBLIC_VIDEO_MODELS.map((candidate) => {
        const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[candidate];
        const selected = candidate === model;
        return (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={config.label}
            onClick={() => {
              onChange(candidate);
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
              "hover:bg-gray-50 dark:hover:bg-muted",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  "truncate text-[13px] leading-none",
                  selected ? "font-medium text-primary" : "text-foreground",
                )}
              >
                {config.label}
              </span>
              <span className="truncate text-[11px] leading-none text-muted-foreground">
                {videoModelSummary(
                  config,
                  (duration) => {
                    return t(
                      ($) => {
                        return $.chat.templates.videoModelUpTo;
                      },
                      { duration },
                    );
                  },
                  audio,
                )}
              </span>
            </span>
            {selected && (
              <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}

function VideoSettingsPane({
  resolved,
  config,
  onChange,
}: {
  readonly resolved: ResolvedVideoGenerationOptions;
  readonly config: VideoModelConfig;
  readonly onChange: (next: ResolvedVideoGenerationOptions) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      {/* The model stays visible here as context — it is edited from its own
          zone on the chip, so this pane never nests a second picker. */}
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <span className="text-[13px] text-muted-foreground">
          {t(($) => {
            return $.chat.templates.videoOptionsModel;
          })}
        </span>
        <span className="truncate text-[13px] font-medium text-foreground">
          {config.label}
        </span>
      </div>
      <VideoOptionField
        label={t(($) => {
          return $.chat.templates.videoOptionsRatio;
        })}
        value={resolved.aspectRatio}
        values={config.aspectRatios}
        onChange={(next) => {
          const aspectRatio = config.aspectRatios.find((candidate) => {
            return candidate === next;
          });
          if (aspectRatio !== undefined) {
            onChange({ ...resolved, aspectRatio });
          }
        }}
      />
      <VideoOptionField
        label={t(($) => {
          return $.chat.templates.videoOptionsDuration;
        })}
        value={resolved.duration}
        values={config.durations}
        onChange={(next) => {
          const duration = config.durations.find((candidate) => {
            return candidate === next;
          });
          if (duration !== undefined) {
            onChange({ ...resolved, duration });
          }
        }}
      />
      <VideoOptionField
        label={t(($) => {
          return $.chat.templates.videoOptionsResolution;
        })}
        value={resolved.resolution}
        values={config.resolutions}
        onChange={(next) => {
          const resolution = config.resolutions.find((candidate) => {
            return candidate === next;
          });
          if (resolution !== undefined) {
            onChange({ ...resolved, resolution });
          }
        }}
      />
      {config.supportsGenerateAudio && (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-[13px] text-muted-foreground">
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
              onChange({ ...resolved, generateAudio: checked });
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
  const pane = useGet(signals.template.videoTemplateOptionsPane$);
  const close = useSet(signals.template.closeVideoTemplateOptions$);

  if (!anchor || !value || value.type !== "video") {
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
        className={cn(
          "rounded-xl p-2",
          pane === "model" ? "w-[15rem]" : "w-[17.5rem] px-3 py-2.5",
        )}
        aria-label={t(($) => {
          return pane === "model"
            ? $.chat.templates.videoOptionsModel
            : $.chat.templates.videoOptions;
        })}
      >
        {pane === "model" ? (
          <VideoModelPane
            model={resolved.model}
            onChange={(model) => {
              apply({ ...resolved, model });
              // Picking a model is one decision and it is done; its parameters
              // live one zone away rather than below a second dropdown.
              close();
            }}
          />
        ) : (
          <VideoSettingsPane
            resolved={resolved}
            config={config}
            onChange={apply}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
