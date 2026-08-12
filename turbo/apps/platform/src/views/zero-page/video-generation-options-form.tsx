import type { VideoGenerationOptions } from "@vm0/api-contracts/contracts/chat-threads";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_CONFIGS,
  VIDEO_MODELS,
  resolveVideoGenerationOptions,
  type ResolvedVideoGenerationOptions,
  type VideoModel,
  type VideoModelConfig,
} from "@vm0/core/video-model-catalog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Switch } from "@vm0/ui/components/ui/switch";
import { useTranslation } from "react-i18next";

/** Keep model-relative defaults sparse; generic message settings pin a model. */
function toVideoOptionsPatch(
  next: ResolvedVideoGenerationOptions,
  modelDefaults: ResolvedVideoGenerationOptions,
  persistModel: boolean,
): VideoGenerationOptions {
  return {
    ...(persistModel || next.model !== DEFAULT_VIDEO_MODEL
      ? { model: next.model }
      : {}),
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
}: {
  readonly label: string;
  readonly value: string;
  readonly values: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
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
}: {
  readonly label: string;
  readonly model: VideoModel;
  readonly onChange: (next: string) => void;
}) {
  const models = VIDEO_MODELS.filter((candidate) => {
    return VIDEO_MODEL_CONFIGS[candidate].public;
  });
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select value={model} onValueChange={onChange}>
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

export function VideoGenerationOptionsForm({
  value,
  persistModel = false,
  onChange,
}: {
  readonly value: VideoGenerationOptions | undefined;
  readonly persistModel?: boolean;
  readonly onChange: (next: VideoGenerationOptions) => void;
}) {
  const { t } = useTranslation();
  const resolved = resolveVideoGenerationOptions(value);
  const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[resolved.model];
  const apply = (next: ResolvedVideoGenerationOptions): void => {
    const settled = resolveVideoGenerationOptions(next);
    const modelDefaults = resolveVideoGenerationOptions({
      model: settled.model,
    });
    onChange(toVideoOptionsPatch(settled, modelDefaults, persistModel));
  };

  return (
    <div className="flex flex-col">
      <VideoModelRow
        label={t(($) => {
          return $.chat.templates.videoOptionsModel;
        })}
        model={resolved.model}
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
