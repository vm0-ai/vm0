import { useGet, useSet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Sun,
  Moon,
  Monitor,
  Keyboard,
  Loader2,
  Palette,
  Globe,
} from "lucide-react";
import { cn } from "@okouai/ui";
import { Switch } from "@okouai/ui/components/ui/switch";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import {
  themePreference$,
  type ThemePreference,
  updateThemePreference$,
} from "../../../../../signals/theme.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { cloudBrowserEnabledByDefault$ } from "../../../../../signals/cloud-browser-preference.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import {
  updateSendMode$,
  pendingSendMode$,
} from "../../../../../signals/okou-page/settings/send-mode-preference.ts";
import {
  pendingCloudBrowserEnabledByDefault$,
  updateCloudBrowserEnabledByDefault$,
} from "../../../../../signals/okou-page/settings/cloud-browser-preference.ts";
import { TimezoneSettings } from "../timezone-settings.tsx";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { AccountSection } from "./account-section.tsx";
import { LanguageSettings } from "../language-settings.tsx";
import { ColorThemeSettings } from "../color-theme-settings.tsx";
import { PreferenceCardRow } from "../preference-card-row.tsx";

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

const SEND_OPTIONS: readonly SendMode[] = ["enter", "cmd-enter"];

function EnterBlock() {
  const { t } = useTranslation();
  const prefsLoadable = useLoadable(sendMode$);
  const current: SendMode =
    prefsLoadable.state === "hasData" ? prefsLoadable.data : "enter";
  const [saveModeLoadable, saveSendMode] = useLoadableSet(updateSendMode$);
  const pageSignal = useGet(pageSignal$);
  const pendingMode = useGet(pendingSendMode$);
  const saving = saveModeLoadable.state === "loading" ? pendingMode : null;

  const handleChange = (value: SendMode) => {
    detach(saveSendMode(value, pageSignal), Reason.DomCallback);
  };

  const effective: SendMode = saving ?? current;

  return (
    <div className="flex flex-col gap-3">
      <PreferenceCardRow
        icon={Keyboard}
        title={t(($) => {
          return $.settings.preferences.send.title;
        })}
        description={
          effective === "enter"
            ? t(($) => {
                return $.settings.preferences.send.enterDescription;
              })
            : t(($) => {
                return $.settings.preferences.send.cmdEnterDescription;
              })
        }
      >
        <div className="flex flex-wrap gap-2 shrink-0">
          {SEND_OPTIONS.map((value) => {
            const isActive =
              saving === value ? true : saving === null && current === value;
            const label =
              value === "enter"
                ? t(($) => {
                    return $.settings.preferences.send.enter;
                  })
                : t(($) => {
                    return $.settings.preferences.send.cmdEnter;
                  });
            return (
              <button
                key={value}
                type="button"
                aria-pressed={isActive}
                disabled={saving !== null}
                onClick={() => {
                  handleChange(value);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-[0.7px] px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isActive
                    ? "border-primary/40 bg-primary/10 text-brand-text dark:border-primary/50 dark:bg-primary/15"
                    : "okou-chip text-muted-foreground hover:text-foreground",
                  saving !== null && "opacity-60 cursor-not-allowed",
                )}
              >
                {saving === value && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                {label}
              </button>
            );
          })}
        </div>
      </PreferenceCardRow>
    </div>
  );
}

function CloudBrowserBlock() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(cloudBrowserEnabledByDefault$);
  const current =
    preferenceLoadable.state === "hasData" ? preferenceLoadable.data : true;
  const pending = useGet(pendingCloudBrowserEnabledByDefault$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateCloudBrowserEnabledByDefault$,
  );
  const pageSignal = useGet(pageSignal$);
  const mutating = updateLoadable.state === "loading";
  const effective = pending ?? current;

  const handleToggle = (checked: boolean) => {
    detach(updatePreference(checked, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-3">
      <PreferenceCardRow
        icon={Globe}
        title={t(($) => {
          return $.settings.preferences.chat.cloudBrowser.title;
        })}
        description={t(($) => {
          return $.settings.preferences.chat.cloudBrowser.description;
        })}
      >
        <Switch
          aria-label={t(($) => {
            return $.settings.preferences.chat.cloudBrowser.title;
          })}
          checked={effective}
          onCheckedChange={handleToggle}
          disabled={preferenceLoadable.state !== "hasData" || mutating}
        />
      </PreferenceCardRow>
    </div>
  );
}

export function PreferenceSection() {
  const { t } = useTranslation();
  const featureSwitches = useGet(featureSwitch$);
  const cloudBrowserPreferenceEnabled =
    featureSwitches[FeatureSwitchKey.CloudBrowserPreference] ?? false;

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

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return cloudBrowserPreferenceEnabled
              ? $.settings.preferences.chat.sectionTitle
              : $.settings.preferences.send.sectionTitle;
          })}
          description={t(($) => {
            return cloudBrowserPreferenceEnabled
              ? $.settings.preferences.chat.description
              : $.settings.preferences.send.description;
          })}
        />
        {cloudBrowserPreferenceEnabled ? <CloudBrowserBlock /> : null}
        <EnterBlock />
      </section>

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
