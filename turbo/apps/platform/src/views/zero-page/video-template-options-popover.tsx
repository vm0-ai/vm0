import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui/components/ui/dropdown-menu";
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

/** Half of the slider thumb, in px — see `durationFillWidth`. */
const SLIDER_THUMB_RADIUS = 7;

/**
 * Groups the settings so the pane reads as blocks rather than a run of loose
 * rows. Concentric corners: the popover is 12px and the gap between panels
 * matches its padding at 6px, so a panel is `rounded-md` (12 − 6).
 *
 * The fill is the lightest grey in the scale — `gray-50` was heavy enough that
 * the panels read as the subject rather than as grouping.
 */
function SettingsPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-gray-0 px-2.5 py-2 dark:bg-gray-50">
      {children}
    </div>
  );
}

/** Longest side of an aspect-ratio glyph inside its 24px box. */
const RATIO_GLYPH_SPAN = 20;

/**
 * The ratio drawn at its true proportion. Numbers alone make the user do the
 * arithmetic; the outline answers "which way up, and how wide" before the label
 * is read. Lucide's rectangles are a single fixed shape, so the rect is sized
 * here instead.
 */
function AspectRatioGlyph({ ratio }: { readonly ratio: string }) {
  const [rawWidth, rawHeight] = ratio.split(":").map(Number);
  const width = rawWidth ?? 1;
  const height = rawHeight ?? 1;
  const longest = Math.max(width, height);
  const boxWidth = (width / longest) * RATIO_GLYPH_SPAN;
  const boxHeight = (height / longest) * RATIO_GLYPH_SPAN;
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-6 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <rect
        x={(24 - boxWidth) / 2}
        y={(24 - boxHeight) / 2}
        width={boxWidth}
        height={boxHeight}
        rx={2.5}
      />
    </svg>
  );
}

/**
 * A value chip, following the segmented-control language TabsTrigger already
 * sets: the group recedes into the panel and the selected value sits one step
 * brighter than it. No raised card — a drop shadow on a 28px cell inside a
 * popover reads as clutter at this size.
 */
function OptionChip({
  label,
  glyph,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly glyph?: ReactNode;
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
        "w-full rounded-md text-[13px] leading-none transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        glyph ? "flex flex-col items-center gap-1 py-1.5" : "h-7 px-2",
        selected
          ? "bg-card font-medium text-primary"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {glyph}
      {label}
    </button>
  );
}

/** A setting with a value the chosen model does not let the user change. */
function FixedValueField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
  );
}

/**
 * One setting, fully expanded. Models disagree on how many values they take, so
 * the field adapts instead of forcing every setting through a dropdown: a
 * single accepted value is read only, and everything else is a grid of
 * equal-width chips the user can hit in one click.
 */
function VideoOptionField({
  label,
  value,
  values,
  renderGlyph,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly renderGlyph?: (option: string) => ReactNode;
  readonly onChange: (next: string) => void;
}) {
  if (values.length <= 1) {
    return <FixedValueField label={label} value={value} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {/* Three fixed columns, shared by every chip field, so cells are one
          width down the whole pane however many values a model accepts.
          Ragged rows were what made a long list read as clutter. */}
      <div
        className="grid grid-cols-3 gap-1"
        role="radiogroup"
        aria-label={label}
      >
        {values.map((option) => {
          return (
            <OptionChip
              key={option}
              label={option}
              glyph={renderGlyph?.(option)}
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
 * The thumb travels between its own two half-widths, not the full track, so the
 * fill has to start half a thumb in and shrink by the same amount by the end or
 * it drifts away from the handle at the extremes.
 */
function durationFillWidth(percent: number): string {
  const offset =
    SLIDER_THUMB_RADIUS - (SLIDER_THUMB_RADIUS * 2 * percent) / 100;
  return `calc(${String(percent)}% + ${offset.toFixed(2)}px)`;
}

/**
 * Duration is the one setting whose values are a scale rather than a set: they
 * are consecutive seconds, and how far the scale runs is the clearest single
 * difference between two models. So it reads as a ruler — the track length is
 * the model's range, the ticks are the steps it accepts, and the filled portion
 * is the answer to "how long", which no grid of chips can show at a glance.
 *
 * Built on a native range input so dragging, clicking anywhere on the track,
 * arrow keys, and Home/End all come from the platform rather than from
 * hand-rolled pointer maths.
 */
function VideoDurationField({
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
    return <FixedValueField label={label} value={value} />;
  }
  const last = values.length - 1;
  const index = Math.max(
    0,
    values.findIndex((candidate) => {
      return candidate === value;
    }),
  );
  const percent = (index / last) * 100;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <span className="text-[13px] font-medium tabular-nums text-primary">
          {value}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {/* Ticks sit above the track and share its inset so each one lines up
            with the thumb position that snaps to it. They stay uniform: the
            fill below already carries the value, and tinting them too turns
            the two rows into one smear. */}
        <div
          aria-hidden="true"
          className="flex items-end justify-between px-[7px]"
        >
          {values.map((option) => {
            return (
              <span
                key={option}
                className="h-1 w-px rounded-full bg-gray-400"
              />
            );
          })}
        </div>
        <div className="group relative h-4">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
          <div
            className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-150 ease-out motion-reduce:transition-none"
            style={{ width: durationFillWidth(percent) }}
          />
          <input
            type="range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-label={label}
            aria-valuetext={value}
            onChange={(event) => {
              const next = values[Number(event.target.value)];
              if (next !== undefined) {
                onChange(next);
              }
            }}
            className={cn(
              "absolute inset-0 w-full cursor-pointer appearance-none bg-transparent focus:outline-none",
              "[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
              "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
              "[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-card",
              "[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:transition-transform",
              "[&::-webkit-slider-thumb]:duration-150 [&::-webkit-slider-thumb]:ease-out",
              "hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-125",
              "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-primary/30",
              "motion-reduce:[&::-webkit-slider-thumb]:transition-none",
              "[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
              "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full",
              "[&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-card",
              "[&::-moz-range-thumb]:shadow-sm [&::-moz-range-thumb]:transition-transform",
              "hover:[&::-moz-range-thumb]:scale-110 active:[&::-moz-range-thumb]:scale-125",
              "motion-reduce:[&::-moz-range-thumb]:transition-none",
            )}
          />
        </div>
        {/* The two ends state the model's range, which is what actually differs
            from one model to the next. */}
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{values[0]}</span>
          <span>{values[last]}</span>
        </div>
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

/** "Up to 15s · 480p, 720p · Audio" — what a model gives you, before switching. */
function useVideoModelSummary(): (config: VideoModelConfig) => string {
  const { t } = useTranslation();
  const audio = t(($) => {
    return $.chat.templates.videoSpecAudioOn;
  });
  return (config) => {
    return videoModelSummary(
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
    );
  };
}

/**
 * Model choice for the whole video tab. Video generation is the most expensive
 * thing the composer can start, so the decision sits above the templates as its
 * own labelled control rather than hiding inside a chip the user edits after
 * committing to a template.
 *
 * It is the app's DropdownMenu, so item radius, padding, text size, the state
 * layer hover and keyboard navigation all come from the component.
 */
export function VideoModelPickerRow({
  model,
  onChange,
}: {
  readonly model: VideoModel;
  readonly onChange: (next: VideoModel) => void;
}) {
  const { t } = useTranslation();
  const summarize = useVideoModelSummary();
  const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[model];
  return (
    <div className="flex items-center justify-between gap-3 pb-4">
      <span className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.chat.templates.videoOptionsModel;
        })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t(
              ($) => {
                return $.chat.templates.videoModelLabel;
              },
              { model: config.label },
            )}
            className={cn(
              "flex h-9 items-center gap-2 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]",
              "bg-input px-3 text-sm text-foreground outline-none transition-colors",
              "hover:bg-input-hover focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="font-medium">{config.label}</span>
            <span className="text-[11px] text-muted-foreground">
              {summarize(config)}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="w-[17.5rem]"
        >
          {PUBLIC_VIDEO_MODELS.map((candidate) => {
            const candidateConfig: VideoModelConfig =
              VIDEO_MODEL_CONFIGS[candidate];
            const selected = candidate === model;
            return (
              <DropdownMenuItem
                key={candidate}
                aria-label={candidateConfig.label}
                className="pr-8"
                onClick={() => {
                  onChange(candidate);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      "truncate leading-none",
                      selected && "font-medium text-primary",
                    )}
                  >
                    {candidateConfig.label}
                  </span>
                  <span className="truncate text-[11px] leading-none text-muted-foreground">
                    {summarize(candidateConfig)}
                  </span>
                </span>
                {selected && (
                  <Check
                    className="absolute right-2 text-primary"
                    aria-hidden
                  />
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
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
    <div className="flex flex-col gap-1.5">
      {/* The model stays visible here as context — it is edited from its own
          zone on the chip, so this pane never nests a second picker. */}
      <div className="flex items-baseline justify-between gap-3 px-2.5 pb-0.5 pt-1">
        <span className="text-[13px] text-muted-foreground">
          {t(($) => {
            return $.chat.templates.videoOptionsModel;
          })}
        </span>
        <span className="truncate text-[13px] font-medium text-foreground">
          {config.label}
        </span>
      </div>
      <SettingsPanel>
        <VideoOptionField
          label={t(($) => {
            return $.chat.templates.videoOptionsRatio;
          })}
          value={resolved.aspectRatio}
          values={config.aspectRatios}
          renderGlyph={(option) => {
            return <AspectRatioGlyph ratio={option} />;
          }}
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
      </SettingsPanel>
      <SettingsPanel>
        <VideoDurationField
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
      </SettingsPanel>
      {config.supportsGenerateAudio && (
        <SettingsPanel>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">
              {t(($) => {
                return $.chat.templates.videoOptionsAudio;
              })}
            </span>
            <Switch
              size="compact"
              checked={resolved.generateAudio}
              aria-label={t(($) => {
                return $.chat.templates.videoOptionsAudio;
              })}
              onCheckedChange={(checked) => {
                onChange({ ...resolved, generateAudio: checked });
              }}
            />
          </div>
        </SettingsPanel>
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
        // The gap between panels matches this padding, so the pane is evenly
        // spaced on every side; that 6px is also what sets the panel radius.
        className="w-[17.5rem] p-1.5"
        aria-label={t(($) => {
          return $.chat.templates.videoOptions;
        })}
      >
        <VideoSettingsPane
          resolved={resolved}
          config={config}
          onChange={apply}
        />
      </PopoverContent>
    </Popover>
  );
}
