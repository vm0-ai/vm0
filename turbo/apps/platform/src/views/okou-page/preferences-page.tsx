import { useGet, useSet, useLoadable, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  Sun,
  Moon,
  Monitor,
  Palette,
  Keyboard,
  Loader2,
  Bug,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui/components/ui/tabs";
import { Switch } from "@okouai/ui/components/ui/switch";
import { SegmentControl, SegmentControlItem } from "@okouai/ui";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
} from "../../signals/okou-page/settings/preferences-page.ts";
import { BuildInfoBlock } from "./components/settings/build-info-block.tsx";
import { LanguageSettings } from "./components/settings/language-settings.tsx";
import { ColorThemeSettings } from "./components/settings/color-theme-settings.tsx";

function AppearanceSettings() {
  const { t } = useTranslation();
  const THEME_OPTIONS = [
    { value: "light" as ThemePreference, icon: Sun },
    { value: "dark" as ThemePreference, icon: Moon },
    {
      value: "system" as ThemePreference,
      icon: Monitor,
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
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Palette size={22} className="text-muted-foreground" />
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
        <SegmentControl
          className="shrink-0"
          aria-label={t(($) => {
            return $.settings.preferences.appearance.theme.title;
          })}
          value={currentPref}
          onValueChange={setTheme}
        >
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
              <SegmentControlItem key={value} value={value}>
                <Icon />
                {label}
              </SegmentControlItem>
            );
          })}
        </SegmentControl>
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
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Keyboard size={22} className="text-muted-foreground" />
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
        </div>
        <SegmentControl
          className="shrink-0"
          aria-label={t(($) => {
            return $.settings.preferences.send.title;
          })}
          // The pending mode wins so the selection moves on click rather than
          // after the round trip; the group locks until the write settles.
          value={saving ?? current}
          disabled={saving !== null}
          onValueChange={handleChange}
        >
          {SEND_OPTIONS.map((value) => {
            const label =
              value === "enter"
                ? t(($) => {
                    return $.settings.preferences.send.enter;
                  })
                : t(($) => {
                    return $.settings.preferences.send.cmdEnter;
                  });
            return (
              <SegmentControlItem key={value} value={value}>
                {saving === value && <Loader2 className="animate-spin" />}
                {label}
              </SegmentControlItem>
            );
          })}
        </SegmentControl>
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
            <Bug size={22} className="text-muted-foreground" />
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

export function PreferencesPage() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const showDebug = features?.[FeatureSwitchKey.OkouDebug] ?? false;
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
            <TabsList>
              <TabsTrigger value="appearance">
                {t(($) => {
                  return $.settings.preferences.tabs.appearance;
                })}
              </TabsTrigger>
              <TabsTrigger value="timezone">
                {t(($) => {
                  return $.settings.preferences.tabs.timezone;
                })}
              </TabsTrigger>
              {showModelConfiguration && (
                <TabsTrigger value="model-configuration">
                  {t(($) => {
                    return $.settings.preferences.tabs.models;
                  })}
                </TabsTrigger>
              )}
              {showDebug && (
                <TabsTrigger value="debug">
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
                  <ColorThemeSettings />
                  <LanguageSettings />
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
