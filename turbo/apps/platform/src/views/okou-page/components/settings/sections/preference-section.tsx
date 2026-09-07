import { useGet, useSet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor, Palette } from "lucide-react";
import { cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import {
  themePreference$,
  type ThemePreference,
  updateThemePreference$,
} from "../../../../../signals/theme.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { TimezoneSettings } from "../timezone-settings.tsx";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { AccountSection } from "./account-section.tsx";
import { LanguageSettings } from "../language-settings.tsx";
import { ColorThemeSettings } from "../color-theme-settings.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";
import { SendModePreference } from "./chat-section.tsx";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  icon: typeof Sun;
}[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

function AppearanceBlock() {
  const { t } = useTranslation();
  const prefLoadable = useLoadable(themePreference$);
  const current =
    prefLoadable.state === "hasData" ? prefLoadable.data : "system";
  const updateTheme = useSet(updateThemePreference$);
  const pageSignal = useGet(pageSignal$);

  const handleChange = (value: ThemePreference) => {
    detach(updateTheme(value, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-3">
      <PreferenceCardRow
        icon={Palette}
        title={t(($) => {
          return $.settings.preferences.appearance.theme.title;
        })}
        description={t(($) => {
          return $.settings.preferences.appearance.theme.description;
        })}
      >
        <div className="flex flex-wrap gap-2 shrink-0">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => {
            const isActive = current === value;
            const label =
              value === "light"
                ? t(($) => {
                    return $.settings.preferences.appearance.theme.light;
                  })
                : value === "dark"
                  ? t(($) => {
                      return $.settings.preferences.appearance.theme.dark;
                    })
                  : t(($) => {
                      return $.settings.preferences.appearance.theme.system;
                    });
            return (
              <button
                key={value}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  handleChange(value);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-[0.7px] px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isActive
                    ? "border-primary/40 bg-primary/10 text-brand-text dark:border-primary/50 dark:bg-primary/15"
                    : "okou-chip text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon size={15} />
                {label}
              </button>
            );
          })}
        </div>
      </PreferenceCardRow>
    </div>
  );
}

export function PreferenceSection() {
  const { t } = useTranslation();
  const featureSwitches = useGet(featureSwitch$);
  const chatPreferenceEnabled =
    featureSwitches[FeatureSwitchKey.ChatPreference] ?? false;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.account.sectionTitle;
          })}
        />
        <AccountSection />
      </section>

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.appearance.sectionTitle;
          })}
          description={t(($) => {
            return $.settings.preferences.appearance.description;
          })}
        />
        <AppearanceBlock />
        <ColorThemeSettings />
        <LanguageSettings />
      </section>

      {!chatPreferenceEnabled ? (
        <section className="flex flex-col gap-3">
          <SettingsSectionHeading
            title={t(($) => {
              return $.settings.preferences.send.sectionTitle;
            })}
            description={t(($) => {
              return $.settings.preferences.send.description;
            })}
          />
          <SendModePreference />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.timezone.sectionTitle;
          })}
          description={t(($) => {
            return $.settings.preferences.timezone.description;
          })}
        />
        <TimezoneSettings />
        {featureSwitches[FeatureSwitchKey.MorningBrief] ? (
          <MorningBriefSettings />
        ) : null}
      </section>
    </div>
  );
}
