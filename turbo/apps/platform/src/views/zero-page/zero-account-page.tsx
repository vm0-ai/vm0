import { useGet, useSet, useLoadable, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconPalette,
  IconKeyboard,
  IconLoader2,
  IconBug,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Switch } from "@vm0/ui/components/ui/switch";
import { cn } from "@vm0/ui";
import type { SendMode } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { TimezoneSettings } from "./components/settings/timezone-settings.tsx";
import { PersonalProvidersTab } from "./components/preferences/personal-providers-tab.tsx";
import {
  themePreference$,
  setTheme$,
  type ThemePreference,
} from "../../signals/theme.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  preferencesTab$,
  setPreferencesTab$,
  type PreferencesTab,
  updateSendMode$,
  pendingSendMode$,
  captureNetworkBodiesRemaining$,
  updateCaptureNetworkBodies$,
} from "../../signals/zero-page/settings/preferences-page.ts";
import { BuildInfoBlock } from "./components/settings/build-info-block.tsx";
import { LanguageSettings } from "./components/settings/language-settings.tsx";

function AppearanceSettings() {
  const { t } = useTranslation();
  const THEME_OPTIONS = [
    { value: "light" as ThemePreference, icon: IconSun },
    { value: "dark" as ThemePreference, icon: IconMoon },
    {
      value: "system" as ThemePreference,
      icon: IconDeviceDesktop,
    },
  ] as const;
  const prefLoadable = useLoadable(themePreference$);
  const currentPref =
    prefLoadable.state === "hasData" ? prefLoadable.data : "system";
  const setTheme = useSet(setTheme$);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.preferences.appearance.description;
        })}
      </p>
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
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
        <div className="flex gap-2 shrink-0">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => {
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
                aria-pressed={currentPref === value}
                onClick={() => {
                  return setTheme(value);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-[0.7px] px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  currentPref === value
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

function SendModeSettings() {
  const { t } = useTranslation();
  const SEND_OPTIONS: readonly SendMode[] = ["enter", "cmd-enter"];
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

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.preferences.send.description;
        })}
      </p>
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
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
            {(saving ?? current) === "enter"
              ? t(($) => {
                  return $.settings.preferences.send.enterDescription;
                })
              : t(($) => {
                  return $.settings.preferences.send.cmdEnterDescription;
                })}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
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
                  return handleChange(value);
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

const CAPTURE_RUN_COUNT = 3;

function CaptureNetworkBodiesSettings() {
  const { t } = useTranslation();
  const remainingLoadable = useLoadable(captureNetworkBodiesRemaining$);
  const remaining =
    remainingLoadable.state === "hasData" ? remainingLoadable.data : 0;
  const [captureLoadable, updateCapture] = useLoadableSet(
    updateCaptureNetworkBodies$,
  );
  const saving = captureLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const enabled = remaining > 0;

  const handleToggle = (checked: boolean) => {
    detach(
      updateCapture(checked ? CAPTURE_RUN_COUNT : 0, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.preferences.debug.capture.description;
        })}
      </p>
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconBug size={22} stroke={1.5} className="text-muted-foreground" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.debug.capture.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {enabled
              ? t(
                  ($) => {
                    return $.settings.preferences.debug.capture.enabled;
                  },
                  {
                    count: remaining,
                  },
                )
              : t(($) => {
                  return $.settings.preferences.debug.capture.disabled;
                })}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={saving}
        />
      </div>
    </div>
  );
}

function resolveVisiblePreferencesTab(
  tab: PreferencesTab,
  {
    showDebug,
    showModelConfiguration,
  }: { showDebug: boolean; showModelConfiguration: boolean },
): PreferencesTab {
  if (tab === "debug" && !showDebug) {
    return "appearance";
  }
  if (tab === "model-configuration" && !showModelConfiguration) {
    return "appearance";
  }
  return tab;
}

export function ZeroPreferencesPage() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const showDebug = features?.[FeatureSwitchKey.ZeroDebug] ?? false;
  const showLanguagePreference =
    features?.[FeatureSwitchKey.LanguagePreference] ?? false;
  const showModelConfiguration = true;
  const tab = useGet(preferencesTab$);
  const activeTab = resolveVisiblePreferencesTab(tab, {
    showDebug,
    showModelConfiguration,
  });
  const setTab = useSet(setPreferencesTab$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-4">
        <div className="mx-auto max-w-[900px]">
          <h1 className="hidden md:block text-xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.settings.preferences.pageTitle;
            })}
          </h1>
          <p className="hidden md:block text-sm text-muted-foreground mt-1">
            {t(($) => {
              return $.settings.preferences.pageDescription;
            })}
          </p>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-3 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-8">
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              return setTab(v);
            }}
          >
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="appearance"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                {t(($) => {
                  return $.settings.preferences.tabs.appearance;
                })}
              </TabsTrigger>
              <TabsTrigger
                value="timezone"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                {t(($) => {
                  return $.settings.preferences.tabs.timezone;
                })}
              </TabsTrigger>
              {showModelConfiguration && (
                <TabsTrigger
                  value="model-configuration"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  {t(($) => {
                    return $.settings.preferences.tabs.models;
                  })}
                </TabsTrigger>
              )}
              {showDebug && (
                <TabsTrigger
                  value="debug"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  {t(($) => {
                    return $.settings.preferences.debug.tab;
                  })}
                </TabsTrigger>
              )}
            </TabsList>

            <div className="mt-4">
              {activeTab === "appearance" && (
                <div className="flex flex-col gap-6">
                  <AppearanceSettings />
                  {showLanguagePreference && <LanguageSettings />}
                  <SendModeSettings />
                </div>
              )}
              {activeTab === "timezone" && <TimezoneSettings />}
              {activeTab === "model-configuration" &&
                showModelConfiguration && <PersonalProvidersTab />}
              {activeTab === "debug" && showDebug && (
                <div className="flex flex-col gap-6">
                  <BuildInfoBlock />
                  <CaptureNetworkBodiesSettings />
                </div>
              )}
            </div>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
