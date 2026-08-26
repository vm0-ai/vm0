import { useGet, useSet } from "ccstate-react";
import { Check, SwatchBook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cn } from "@okouai/ui";

import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import {
  colorTheme$,
  setColorTheme$,
  type ColorTheme,
} from "../../../../signals/theme.ts";

export function ColorThemeSettings() {
  const { t } = useTranslation();
  const featureSwitches = useGet(featureSwitch$);
  const colorTheme = useGet(colorTheme$);
  const setColorTheme = useSet(setColorTheme$);

  if (!featureSwitches[FeatureSwitchKey.GradientColorThemes]) {
    return null;
  }

  const options: readonly {
    readonly value: ColorTheme;
    readonly label: string;
  }[] = [
    {
      value: "golden-hour",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.goldenHour;
      }),
    },
    {
      value: "citrus-spark",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.citrusSpark;
      }),
    },
    {
      value: "berry-blush",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.berryBlush;
      }),
    },
    {
      value: "cotton-sky",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.cottonSky;
      }),
    },
    {
      value: "blue-horizon",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.blueHorizon;
      }),
    },
    {
      value: "daydream",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.daydream;
      }),
    },
    {
      value: "deep-lagoon",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.deepLagoon;
      }),
    },
    {
      value: "limelight",
      label: t(($) => {
        return $.settings.preferences.appearance.colorTheme.options.limelight;
      }),
    },
  ];

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-4 zero-border">
      <div className="flex items-center gap-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <SwatchBook size={22} className="text-muted-foreground" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.appearance.colorTheme.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.appearance.colorTheme.description;
            })}
          </div>
        </div>
      </div>
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        role="group"
        aria-label={t(($) => {
          return $.settings.preferences.appearance.colorTheme.title;
        })}
      >
        {options.map(({ value, label }) => {
          const selected = colorTheme === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setColorTheme(value);
              }}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-lg border border-[0.7px] bg-background/80 p-2 text-left transition-[border-color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-[hsl(var(--gray-500))] bg-[var(--zero-color-theme-selected)] shadow-[0_0_0_1px_hsl(var(--ring)/0.12)]"
                  : "border-border hover:border-[hsl(var(--gray-500))] hover:bg-accent",
              )}
            >
              <span
                aria-hidden="true"
                data-color-theme={value}
                className="zero-color-theme-swatch h-8 w-8 shrink-0 rounded-full border border-black/5"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {label}
              </span>
              {selected && (
                <Check
                  size={14}
                  aria-hidden="true"
                  className="shrink-0 text-foreground"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
