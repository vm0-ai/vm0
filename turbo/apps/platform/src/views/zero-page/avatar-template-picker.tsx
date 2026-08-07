import {
  IconAdjustmentsHorizontal,
  IconArrowLeft,
  IconCheck,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconUser,
} from "@tabler/icons-react";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ZeroAvatarVideoAvatar,
  ZeroAvatarVideoAvatarsQuery,
  ZeroAvatarVideoVoice,
  ZeroAvatarVideoVoicesQuery,
} from "@vm0/api-contracts/contracts/zero-avatar-video";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@vm0/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SyntheticEvent,
  UIEvent as ReactUIEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isSelectedAvatarTemplate } from "../../signals/zero-page/avatar-template-selection.ts";
import type { ComposerSignals } from "../../signals/zero-page/composer-signals.ts";

const AVATAR_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";
const ALL_FILTER_VALUE = "__all__";
const CATALOG_AUTO_LOAD_THRESHOLD_PX = 320;

const AVATAR_STYLE_VALUES = [
  "professional",
  "social",
] as const satisfies readonly NonNullable<
  ZeroAvatarVideoAvatarsQuery["style"]
>[];
const AVATAR_GENDER_VALUES = [
  "female",
  "male",
] as const satisfies readonly NonNullable<
  ZeroAvatarVideoAvatarsQuery["gender"]
>[];
const AVATAR_AGE_VALUES = [
  "adult",
  "senior",
  "young_adult",
] as const satisfies readonly NonNullable<ZeroAvatarVideoAvatarsQuery["age"]>[];
const AVATAR_SCENE_VALUES = [
  "lifestyle",
  "outdoors",
  "business",
  "studio",
  "health_fitness",
  "education",
  "news",
] as const satisfies readonly NonNullable<
  ZeroAvatarVideoAvatarsQuery["scene"]
>[];
const AVATAR_ETHNICITY_VALUES = [
  "european",
  "african",
  "south_asian",
  "east_asian",
  "middle_eastern",
  "south_american",
  "north_american",
] as const satisfies readonly NonNullable<
  ZeroAvatarVideoAvatarsQuery["ethnicity"]
>[];
const VOICE_GENDER_VALUES = [
  "female",
  "male",
] as const satisfies readonly NonNullable<
  ZeroAvatarVideoVoicesQuery["gender"]
>[];
const VOICE_AGE_VALUES = [
  "young",
  "middle_aged",
  "old",
] as const satisfies readonly NonNullable<ZeroAvatarVideoVoicesQuery["age"]>[];

interface CatalogFilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

function formatJoggCategoryValue(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`;
}

function catalogFilterOptions<T extends string>(
  values: readonly T[],
): readonly CatalogFilterOption<T>[] {
  return values.map((value) => {
    return { value, label: formatJoggCategoryValue(value) };
  });
}

function CatalogFilterField<T extends string>({
  label,
  allLabel,
  value,
  options,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: T | undefined;
  readonly options: readonly CatalogFilterOption<T>[];
  readonly disabled?: boolean;
  readonly onChange: (value: T | undefined) => void;
}) {
  const selectedLabel =
    options.find((option) => {
      return option.value === value;
    })?.label ?? allLabel;
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <Select
        value={value ?? ALL_FILTER_VALUE}
        disabled={disabled}
        onValueChange={(nextValue) => {
          if (nextValue === ALL_FILTER_VALUE) {
            onChange(undefined);
            return;
          }
          const nextOption = options.find((option) => {
            return option.value === nextValue;
          });
          if (nextOption) {
            onChange(nextOption.value);
          }
        }}
      >
        <SelectTrigger
          aria-label={`${label}: ${selectedLabel}`}
          className="h-9 w-full rounded-lg bg-background text-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>{allLabel}</SelectItem>
          {options.map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function CatalogFiltersPopover({
  activeCount,
  onClear,
  children,
}: {
  readonly activeCount: number;
  readonly onClear: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-2 rounded-full bg-background px-3 shadow-none"
        >
          <IconAdjustmentsHorizontal size={15} stroke={1.7} />
          {t(($) => {
            return $.artifacts.templates.filters.title;
          })}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(340px,calc(100vw-2rem))] rounded-xl p-4"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">
            {t(($) => {
              return $.artifacts.templates.filters.title;
            })}
          </p>
          {activeCount > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:text-primary/80"
              onClick={onClear}
            >
              {t(($) => {
                return $.artifacts.templates.filters.clear;
              })}
            </button>
          )}
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function AvatarAspectRatioPicker({
  value,
  onChange,
}: {
  readonly value: "portrait" | "landscape";
  readonly onChange: (value: "portrait" | "landscape") => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.filters.aspectRatio;
  });
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-xl border border-border bg-muted/50 p-1"
    >
      <button
        type="button"
        aria-label={`${label}: 9:16`}
        aria-pressed={value === "portrait"}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-all",
          value === "portrait"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => {
          onChange("portrait");
        }}
      >
        <span className="h-4 w-2.5 rounded-[2px] border-2 border-current" />
        9:16
      </button>
      <button
        type="button"
        aria-label={`${label}: 16:9`}
        aria-pressed={value === "landscape"}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-all",
          value === "landscape"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => {
          onChange("landscape");
        }}
      >
        <span className="h-2.5 w-4 rounded-[2px] border-2 border-current" />
        16:9
      </button>
    </div>
  );
}

function hasPlayableAvatarVideo(videoUrl: string | undefined): boolean {
  return Boolean(
    videoUrl && /\.(?:m4v|mov|mp4|ogv|webm)(?:[?#]|$)/iu.test(videoUrl),
  );
}

function setAvatarTemplateVideoLoading(
  video: HTMLVideoElement,
  loading: boolean,
): void {
  const preview = video.closest<HTMLElement>("[data-avatar-template-preview]");
  if (preview) {
    preview.dataset.loading = String(loading);
  }
}

function playAvatarTemplatePreview(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (!video) {
    return;
  }
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  setAvatarTemplateVideoLoading(
    video,
    video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
  );
  detach(video.play(), Reason.DomCallback);
}

function resetAvatarTemplatePreview(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (!video) {
    return;
  }
  setAvatarTemplateVideoLoading(video, false);
  video.pause();
  video.currentTime = 0;
}

function avatarMediaAspectClass(aspectRatio: "portrait" | "landscape"): string {
  return aspectRatio === "portrait" ? "aspect-[9/16]" : "aspect-video";
}

function AvatarTemplateMedia({
  avatar,
  aspectRatio,
  className,
}: {
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly className?: string;
}) {
  const previewVideoUrl = hasPlayableAvatarVideo(avatar.videoUrl)
    ? avatar.videoUrl
    : undefined;
  const previewImageUrl = avatar.coverUrl ?? avatar.videoUrl;
  return (
    <div
      data-avatar-template-preview=""
      data-loading="false"
      className={cn(
        "group/avatar-preview relative flex w-full shrink-0 items-center justify-center overflow-hidden bg-muted",
        avatarMediaAspectClass(aspectRatio),
        className,
      )}
    >
      {previewVideoUrl ? (
        <>
          <video
            src={previewVideoUrl}
            poster={avatar.coverUrl}
            muted
            loop
            playsInline
            preload="none"
            className="h-full w-full object-cover"
            onWaiting={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, true);
            }}
            onPlaying={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, false);
            }}
            onError={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, false);
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/15 group-data-[loading=true]/avatar-preview:flex"
          >
            <IconLoader2 className="size-6 animate-spin text-white drop-shadow" />
          </span>
        </>
      ) : previewImageUrl ? (
        <img
          src={previewImageUrl}
          alt={avatar.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <IconUser
          size={40}
          stroke={1.4}
          className="text-muted-foreground"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function avatarTemplateCardClass(selected: boolean): string {
  return cn(
    "group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    AVATAR_CARD_SHADOW,
    selected ? "border-primary" : "border-border",
  );
}

function AvatarTemplateCardContent({
  avatar,
  aspectRatio,
  selected,
}: {
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly selected: boolean;
}) {
  return (
    <>
      <AvatarTemplateMedia avatar={avatar} aspectRatio={aspectRatio} />
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {avatar.name}
        </p>
        {selected && (
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <IconCheck size={13} stroke={2.2} />
          </span>
        )}
      </div>
    </>
  );
}

function AvatarTemplateCard({
  avatar,
  aspectRatio,
  selected,
  onSelect,
}: {
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly selected: boolean;
  readonly onSelect: (avatar: ZeroAvatarVideoAvatar) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.artifacts.templates.selectTemplate;
        },
        { title: avatar.name },
      )}
      aria-pressed={selected}
      onClick={() => {
        onSelect(avatar);
      }}
      className={avatarTemplateCardClass(selected)}
      onFocus={playAvatarTemplatePreview}
      onBlur={resetAvatarTemplatePreview}
      onMouseEnter={playAvatarTemplatePreview}
      onMouseLeave={resetAvatarTemplatePreview}
    >
      <AvatarTemplateCardContent
        avatar={avatar}
        aspectRatio={aspectRatio}
        selected={selected}
      />
    </button>
  );
}

function AvatarCatalogFilters({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const filters = useGet(signals.template.avatarTemplateFilters$);
  const setFilters = useSet(signals.template.setAvatarTemplateFilters$);
  const allLabel = t(($) => {
    return $.artifacts.templates.filters.all;
  });
  const activeCount = [
    filters.style,
    filters.gender,
    filters.age,
    filters.scene,
    filters.ethnicity,
  ].filter(Boolean).length;

  return (
    <div
      data-avatar-catalog-toolbar=""
      className="sticky top-0 z-10 mb-5 flex flex-wrap items-center justify-between gap-3 bg-card pb-4"
    >
      <AvatarAspectRatioPicker
        value={filters.aspectRatio}
        onChange={(aspectRatio) => {
          setFilters({ ...filters, aspectRatio });
        }}
      />
      <CatalogFiltersPopover
        activeCount={activeCount}
        onClear={() => {
          setFilters({
            aspectRatio: filters.aspectRatio,
            style: undefined,
            gender: undefined,
            age: undefined,
            scene: undefined,
            ethnicity: undefined,
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.style;
            })}
            allLabel={allLabel}
            value={filters.style}
            options={catalogFilterOptions(AVATAR_STYLE_VALUES)}
            onChange={(style) => {
              setFilters({ ...filters, style });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.gender;
            })}
            allLabel={allLabel}
            value={filters.gender}
            options={catalogFilterOptions(AVATAR_GENDER_VALUES)}
            onChange={(gender) => {
              setFilters({ ...filters, gender });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.age;
            })}
            allLabel={allLabel}
            value={filters.age}
            options={catalogFilterOptions(AVATAR_AGE_VALUES)}
            onChange={(age) => {
              setFilters({ ...filters, age });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.scene;
            })}
            allLabel={allLabel}
            value={filters.scene}
            options={catalogFilterOptions(AVATAR_SCENE_VALUES)}
            onChange={(scene) => {
              setFilters({ ...filters, scene });
            }}
          />
          <div className="col-span-2">
            <CatalogFilterField
              label={t(($) => {
                return $.artifacts.templates.filters.ethnicity;
              })}
              allLabel={allLabel}
              value={filters.ethnicity}
              options={catalogFilterOptions(AVATAR_ETHNICITY_VALUES)}
              onChange={(ethnicity) => {
                setFilters({ ...filters, ethnicity });
              }}
            />
          </div>
        </div>
      </CatalogFiltersPopover>
    </div>
  );
}

function AvatarVoiceFilters({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const filters = useGet(signals.template.avatarTemplateVoiceFilters$);
  const setFilters = useSet(signals.template.setAvatarTemplateVoiceFilters$);
  const filterOptions = useLoadable(
    signals.template.avatarTemplateVoiceFilterOptions$,
  );
  const allLabel = t(($) => {
    return $.artifacts.templates.filters.all;
  });
  const languages =
    filterOptions.state === "hasData" ? filterOptions.data.languages : [];
  const useCases =
    filterOptions.state === "hasData" ? filterOptions.data.useCases : [];
  const activeCount = [
    filters.language,
    filters.gender,
    filters.age,
    filters.useCase,
  ].filter(Boolean).length;

  return (
    <CatalogFiltersPopover
      activeCount={activeCount}
      onClear={() => {
        setFilters({
          language: undefined,
          gender: undefined,
          age: undefined,
          useCase: undefined,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.language;
          })}
          allLabel={allLabel}
          value={filters.language}
          options={catalogFilterOptions(languages)}
          disabled={filterOptions.state !== "hasData"}
          onChange={(language) => {
            setFilters({ ...filters, language });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.gender;
          })}
          allLabel={allLabel}
          value={filters.gender}
          options={catalogFilterOptions(VOICE_GENDER_VALUES)}
          onChange={(gender) => {
            setFilters({ ...filters, gender });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.age;
          })}
          allLabel={allLabel}
          value={filters.age}
          options={catalogFilterOptions(VOICE_AGE_VALUES)}
          onChange={(age) => {
            setFilters({ ...filters, age });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.useCase;
          })}
          allLabel={allLabel}
          value={filters.useCase}
          options={catalogFilterOptions(useCases)}
          disabled={filterOptions.state !== "hasData"}
          onChange={(useCase) => {
            setFilters({ ...filters, useCase });
          }}
        />
      </div>
    </CatalogFiltersPopover>
  );
}

function AvatarTemplateSkeletonGrid({
  aspectRatio,
}: {
  readonly aspectRatio: "portrait" | "landscape";
}) {
  return (
    <div
      data-avatar-template-skeleton-grid=""
      className={cn(
        "grid gap-4",
        aspectRatio === "portrait"
          ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
          : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {Array.from(
        { length: aspectRatio === "portrait" ? 8 : 6 },
        (_, index) => {
          return (
            <Skeleton
              key={index}
              className={cn(avatarMediaAspectClass(aspectRatio), "rounded-xl")}
            />
          );
        },
      )}
    </div>
  );
}

function AvatarVoiceSkeletonGrid() {
  return (
    <div
      data-avatar-voice-skeleton-grid=""
      className="grid grid-cols-1 gap-2.5"
    >
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="h-[86px] rounded-xl" />;
      })}
    </div>
  );
}

function CatalogLoadingSpinner() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex h-14 shrink-0 items-center justify-center text-muted-foreground"
    >
      <IconLoader2 className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">
        {t(($) => {
          return $.settings.shared.loading;
        })}
      </span>
    </div>
  );
}

function AvatarTemplateEmpty({ error }: { readonly error: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <p className="text-sm font-semibold text-muted-foreground">
        {error
          ? t(($) => {
              return $.artifacts.catalog.error;
            })
          : t(($) => {
              return $.artifacts.templates.noMatches;
            })}
      </p>
    </div>
  );
}

function setVoiceCardPlaying(
  event: SyntheticEvent<HTMLAudioElement>,
  playing: boolean,
): void {
  const card = event.currentTarget.closest("[data-avatar-voice-card]");
  if (card instanceof HTMLElement) {
    card.dataset.playing = String(playing);
  }
}

function toggleVoicePreview(event: ReactMouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
  const card = event.currentTarget.closest("[data-avatar-voice-card]");
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const audio = card.querySelector("audio[data-avatar-voice-preview]");
  if (!(audio instanceof HTMLAudioElement)) {
    return;
  }
  if (!audio.paused) {
    audio.pause();
    return;
  }
  const picker = card.closest("[data-avatar-voice-picker]");
  const candidates =
    picker?.querySelectorAll("audio[data-avatar-voice-preview]") ?? [];
  for (const candidate of candidates) {
    if (candidate instanceof HTMLAudioElement && candidate !== audio) {
      candidate.pause();
    }
  }
  detach(audio.play(), Reason.DomCallback);
}

function VoicePreviewControl({
  voice,
}: {
  readonly voice: ZeroAvatarVideoVoice;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewVoice;
          },
          { title: voice.name },
        )}
        disabled={!voice.sampleUrl}
        onClick={toggleVoicePreview}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/10 text-primary transition-all hover:scale-105 hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40",
          "group-data-[playing=true]/voice:bg-primary group-data-[playing=true]/voice:text-primary-foreground",
        )}
      >
        <IconPlayerPlay
          size={17}
          stroke={1.9}
          className="ml-0.5 group-data-[playing=true]/voice:hidden"
        />
        <IconPlayerPause
          size={17}
          stroke={1.9}
          className="hidden group-data-[playing=true]/voice:block"
        />
      </button>
      {voice.sampleUrl && (
        <audio
          data-avatar-voice-preview=""
          src={voice.sampleUrl}
          preload="none"
          className="hidden"
          onPlay={(event) => {
            setVoiceCardPlaying(event, true);
          }}
          onPause={(event) => {
            setVoiceCardPlaying(event, false);
          }}
          onEnded={(event) => {
            setVoiceCardPlaying(event, false);
          }}
        />
      )}
    </>
  );
}

function AvatarVoiceCard({
  voice,
  selected,
  recommended,
  onSelect,
}: {
  readonly voice: ZeroAvatarVideoVoice;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly onSelect: (voice: ZeroAvatarVideoVoice) => void;
}) {
  const { t } = useTranslation();
  const recommendedDescriptionId = `avatar-voice-recommendation-${encodeURIComponent(voice.id)}`;
  const metadata = Array.from(
    new Set(
      [voice.language, voice.gender, voice.age, voice.accent]
        .filter((value): value is string => {
          return value !== undefined;
        })
        .map(formatJoggCategoryValue),
    ),
  );
  const description = voice.useCase
    ? formatJoggCategoryValue(voice.useCase)
    : undefined;
  const selectVoice = () => {
    onSelect(voice);
  };
  return (
    <div
      data-avatar-voice-card=""
      data-playing="false"
      data-recommended={recommended ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.templates.selectVoice;
        },
        { title: voice.name },
      )}
      aria-pressed={selected}
      aria-describedby={recommended ? recommendedDescriptionId : undefined}
      onClick={selectVoice}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectVoice();
        }
      }}
      className={cn(
        "group/voice flex cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 transition-colors duration-200 hover:border-foreground/20 hover:bg-muted/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        AVATAR_CARD_SHADOW,
        selected
          ? "border-primary bg-primary/[0.04]"
          : recommended
            ? "border-primary/40 bg-primary/[0.025]"
            : "border-border",
      )}
    >
      <VoicePreviewControl voice={voice} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {voice.name}
            </p>
            {description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {recommended && (
              <span
                id={recommendedDescriptionId}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
              >
                {t(($) => {
                  return $.artifacts.templates.recommended;
                })}
              </span>
            )}
            {selected && (
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                aria-hidden="true"
              >
                <IconCheck size={13} stroke={2.2} />
              </span>
            )}
          </div>
        </div>
        {metadata.length > 0 && (
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
            {metadata.map((item) => {
              return (
                <span
                  key={item}
                  className="max-w-32 truncate rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {item}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function recommendedVoiceFirst(
  voices: readonly ZeroAvatarVideoVoice[],
  recommendedVoice: ZeroAvatarVideoVoice | null,
): readonly ZeroAvatarVideoVoice[] {
  if (!recommendedVoice) {
    return voices;
  }
  return [
    recommendedVoice,
    ...voices.filter((voice) => {
      return voice.id !== recommendedVoice.id;
    }),
  ];
}

function SelectedAvatarCard({
  avatar,
  aspectRatio,
}: {
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
}) {
  const { t } = useTranslation();
  const playable = hasPlayableAvatarVideo(avatar.videoUrl);
  return (
    <div
      data-selected-avatar-card=""
      tabIndex={playable ? 0 : undefined}
      aria-label={
        playable
          ? t(
              ($) => {
                return $.artifacts.templates.previewAvatarVideo;
              },
              { title: avatar.name },
            )
          : undefined
      }
      className={avatarTemplateCardClass(false)}
      onFocus={playAvatarTemplatePreview}
      onBlur={resetAvatarTemplatePreview}
      onMouseEnter={playAvatarTemplatePreview}
      onMouseLeave={resetAvatarTemplatePreview}
    >
      <AvatarTemplateCardContent
        avatar={avatar}
        aspectRatio={aspectRatio}
        selected={false}
      />
    </div>
  );
}

function AvatarVoiceCatalog({
  signals,
  value,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (voice: ZeroAvatarVideoVoice) => void;
}) {
  const catalog = useLoadable(signals.template.avatarTemplateVoiceCatalogPage$);
  const recommendation = useLoadable(
    signals.template.avatarTemplateRecommendedVoice$,
  );
  const lastCatalog = useLastResolved(
    signals.template.avatarTemplateVoiceCatalogPage$,
  );
  const generation = useGet(
    signals.template.avatarTemplateVoiceCatalogGeneration$,
  );
  const loadMore = useSet(signals.template.loadMoreAvatarTemplateVoices$);
  const loadingMore = useGet(signals.template.avatarTemplateVoicesLoadingMore$);
  const visibleCatalog =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const pageSignal = useGet(pageSignal$);
  const selectedVoiceId =
    value?.type === "video" ? value.selection.voiceId : undefined;
  const recommendedVoice =
    recommendation.state === "hasData"
      ? (recommendation.data ?? visibleCatalog?.voices[0] ?? null)
      : recommendation.state === "hasError"
        ? null
        : undefined;
  const visibleVoices =
    visibleCatalog && recommendedVoice !== undefined
      ? recommendedVoiceFirst(visibleCatalog.voices, recommendedVoice)
      : undefined;
  const handleVoiceScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (catalog.state !== "hasData" || !catalog.data.hasNext) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > CATALOG_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "avatar voice paging");
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div
        data-avatar-voice-list-scroll=""
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={handleVoiceScroll}
      >
        {catalog.state === "hasError" ? (
          <AvatarTemplateEmpty error />
        ) : visibleVoices === undefined ? (
          <AvatarVoiceSkeletonGrid />
        ) : visibleVoices.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5">
            {visibleVoices.map((voice) => {
              return (
                <AvatarVoiceCard
                  key={voice.id}
                  voice={voice}
                  selected={voice.id === selectedVoiceId}
                  recommended={voice.id === recommendedVoice?.id}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        ) : (
          <AvatarTemplateEmpty error={false} />
        )}
        {loadingMore && <CatalogLoadingSpinner />}
      </div>
    </section>
  );
}

function AvatarVoicePickerContent({
  signals,
  avatar,
  value,
  onBack,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onBack: () => void;
  readonly onSelect: (
    avatar: ZeroAvatarVideoAvatar,
    voice: ZeroAvatarVideoVoice,
  ) => void;
}) {
  const { t } = useTranslation();
  const aspectRatio = useGet(
    signals.template.avatarTemplateFilters$,
  ).aspectRatio;

  return (
    <div
      data-avatar-voice-picker=""
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="mb-4 flex shrink-0 items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t(($) => {
            return $.artifacts.templates.backToAvatars;
          })}
          onClick={onBack}
        >
          <IconArrowLeft className="size-4" />
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {t(
            ($) => {
              return $.artifacts.templates.chooseVoice;
            },
            { title: avatar.name },
          )}
        </h3>
        <AvatarVoiceFilters signals={signals} />
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden md:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.55fr)] md:grid-rows-1">
        <div
          className={cn(
            "mx-auto w-full self-start",
            aspectRatio === "portrait" ? "max-w-[210px]" : "max-w-72",
          )}
        >
          <SelectedAvatarCard avatar={avatar} aspectRatio={aspectRatio} />
        </div>
        <AvatarVoiceCatalog
          signals={signals}
          value={value}
          onSelect={(voice) => {
            onSelect(avatar, voice);
          }}
        />
      </div>
    </div>
  );
}

function AvatarCatalogPickerContent({
  signals,
  value,
  onUse,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onUse: (avatar: ZeroAvatarVideoAvatar) => void;
}) {
  const catalog = useLoadable(signals.template.avatarTemplateCatalogPage$);
  const lastCatalog = useLastResolved(
    signals.template.avatarTemplateCatalogPage$,
  );
  const generation = useGet(signals.template.avatarTemplateCatalogGeneration$);
  const filters = useGet(signals.template.avatarTemplateFilters$);
  const loadMore = useSet(signals.template.loadMoreAvatarTemplates$);
  const loadingMore = useGet(signals.template.avatarTemplatesLoadingMore$);
  const visibleCatalog =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const pageSignal = useGet(pageSignal$);
  const handleAvatarScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (catalog.state !== "hasData" || !catalog.data.hasNext) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > CATALOG_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "avatar catalog paging");
  };

  return (
    <div
      data-avatar-template-grid-scroll=""
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onScroll={handleAvatarScroll}
    >
      <AvatarCatalogFilters signals={signals} />
      {catalog.state === "hasError" ? (
        <AvatarTemplateEmpty error />
      ) : visibleCatalog === undefined ? (
        <AvatarTemplateSkeletonGrid aspectRatio={filters.aspectRatio} />
      ) : (
        <>
          {visibleCatalog.avatars.length > 0 ? (
            <div
              className={cn(
                "grid gap-4",
                filters.aspectRatio === "portrait"
                  ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                  : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
              )}
            >
              {visibleCatalog.avatars.map((avatar) => {
                return (
                  <AvatarTemplateCard
                    key={avatar.id}
                    avatar={avatar}
                    aspectRatio={filters.aspectRatio}
                    selected={isSelectedAvatarTemplate(avatar, value)}
                    onSelect={onUse}
                  />
                );
              })}
            </div>
          ) : (
            <AvatarTemplateEmpty error={false} />
          )}
        </>
      )}
      {loadingMore && <CatalogLoadingSpinner />}
    </div>
  );
}

export function AvatarTemplatePickerContent({
  signals,
  value,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (
    avatar: ZeroAvatarVideoAvatar,
    voice: ZeroAvatarVideoVoice,
    aspectRatio: "portrait" | "landscape",
  ) => void;
}) {
  const selectedAvatar = useGet(
    signals.template.selectedAvatarTemplateForVoice$,
  );
  const selectAvatar = useSet(signals.template.selectAvatarTemplateForVoice$);
  const clearVoiceSelection = useSet(
    signals.template.clearAvatarTemplateVoiceSelection$,
  );
  const aspectRatio = useGet(
    signals.template.avatarTemplateFilters$,
  ).aspectRatio;

  if (selectedAvatar) {
    return (
      <AvatarVoicePickerContent
        signals={signals}
        avatar={selectedAvatar}
        value={value}
        onBack={() => {
          clearVoiceSelection();
        }}
        onSelect={(avatar, voice) => {
          clearVoiceSelection();
          onSelect(avatar, voice, aspectRatio);
        }}
      />
    );
  }

  return (
    <AvatarCatalogPickerContent
      signals={signals}
      value={value}
      onUse={(avatar) => {
        selectAvatar(avatar);
      }}
    />
  );
}
