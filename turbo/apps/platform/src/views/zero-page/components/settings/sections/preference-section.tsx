import { useGet, useSet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconKeyboard,
  IconLoader2,
  IconPalette,
} from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import {
  themePreference$,
  setTheme$,
  type ThemePreference,
} from "../../../../../signals/theme.ts";
import { sendMode$ } from "../../../../../signals/send-mode.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";
import {
  updateSendMode$,
  pendingSendMode$,
} from "../../../../../signals/zero-page/settings/preferences-page.ts";
import { TimezoneSettings } from "../timezone-settings.tsx";
import { MorningBriefSettings } from "../morning-brief-settings.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { AccountSection } from "./account-section.tsx";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { LanguageSettings } from "../language-settings.tsx";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  icon: typeof IconSun;
}[] = [
  { value: "light", icon: IconSun },
  { value: "dark", icon: IconMoon },
  { value: "system", icon: IconDeviceDesktop },
];

function AppearanceBlock() {
  const { t } = useTranslation();
  const prefLoadable = useLoadable(themePreference$);
  const current =
    prefLoadable.state === "hasData" ? prefLoadable.data : "system";
  const setTheme = useSet(setTheme$);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <IconPalette
                size={22}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.preferences.appearance.theme.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.appearance.theme.description;
              })}
            </div>
          </div>
        </div>
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
                  setTheme(value);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-[0.7px] px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isActive
                    ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                    : "zero-chip text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon size={15} stroke={1.5} />
                {label}
              </button>
            );
          })}
        </div>
      </div>
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
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <IconKeyboard
                size={22}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.preferences.send.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {effective === "enter"
                ? t(($) => {
                    return $.settings.preferences.send.enterDescription;
                  })
                : t(($) => {
                    return $.settings.preferences.send.cmdEnterDescription;
                  })}
            </div>
          </div>
        </div>
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
                    ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                    : "zero-chip text-muted-foreground hover:text-foreground",
                  saving !== null && "opacity-60 cursor-not-allowed",
                )}
              >
                {saving === value && (
                  <IconLoader2 size={14} className="animate-spin" />
                )}
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function PreferenceSection() {
  const { t } = useTranslation();
  const features = useGet(featureSwitch$);
  const showLanguagePreference =
    features[FeatureSwitchKey.LanguagePreference] ?? false;

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
        {showLanguagePreference && <LanguageSettings />}
      </section>

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.preferences.send.sectionTitle;
          })}
          description={t(($) => {
            return $.settings.preferences.send.description;
          })}
        />
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
        <MorningBriefSettings />
      </section>
    </div>
  );
}
