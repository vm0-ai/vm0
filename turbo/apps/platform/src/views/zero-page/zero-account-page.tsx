import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconPalette,
  IconKeyboard,
  IconLoader2,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { cn } from "@vm0/ui";
import { NotificationSettings } from "./components/settings/notification-settings.tsx";
import { TimezoneSettings } from "./components/settings/timezone-settings.tsx";
import {
  themePreference$,
  setTheme$,
  type ThemePreference,
} from "../../signals/theme.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { SendMode } from "@vm0/core";
import { updateNotificationPreference$ } from "../../signals/zero-page/settings/notification-settings.ts";
import { toast } from "@vm0/ui/components/ui/sonner";

function AppearanceSettings() {
  const THEME_OPTIONS = [
    { value: "light" as ThemePreference, label: "Light", icon: IconSun },
    { value: "dark" as ThemePreference, label: "Dark", icon: IconMoon },
    {
      value: "system" as ThemePreference,
      label: "System",
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
        Choose how the interface looks.
      </p>
      <div
        className="flex items-center gap-4 bg-card p-4 rounded-xl"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
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
          <div className="text-sm font-medium text-foreground">Theme</div>
          <div className="text-sm text-muted-foreground">
            Your preferred color scheme
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              style={{ borderWidth: "0.7px" }}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                currentPref === value
                  ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                  : "zero-chip text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon size={15} stroke={1.5} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SendModeSettings() {
  const SEND_OPTIONS = [
    { value: "enter" as SendMode, label: "Enter" },
    { value: "cmd-enter" as SendMode, label: "⌘ Enter" },
  ] as const;
  const prefsLoadable = useLoadable(sendMode$);
  const current: SendMode =
    prefsLoadable.state === "hasData" ? prefsLoadable.data : "enter";
  const updatePref = useSet(updateNotificationPreference$);
  const saving$ = useCCState<SendMode | null>(null);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);

  const handleChange = (value: SendMode) => {
    setSaving(value);
    detach(
      (async () => {
        await updatePref({ sendMode: value });
        setSaving(null);
      })().catch(() => {
        setSaving(null);
        toast.error("Failed to save send mode preference");
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Choose how to send messages in chat.
      </p>
      <div
        className="flex items-center gap-4 bg-card p-4 rounded-xl"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
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
            Send message with
          </div>
          <div className="text-sm text-muted-foreground">
            {current === "enter"
              ? "Press Enter to send, Shift+Enter for new line"
              : "Press ⌘/Ctrl+Enter to send, Enter for new line"}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {SEND_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              disabled={saving !== null}
              onClick={() => handleChange(value)}
              style={{ borderWidth: "0.7px" }}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                (saving === value ? true : saving === null && current === value)
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
          ))}
        </div>
      </div>
    </div>
  );
}

export function ZeroPreferencesPage() {
  const tab$ = useCCState("appearance");
  const tab = useGet(tab$);
  const setTab = useSet(tab$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Preferences
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your appearance, notification and agent runtime preferences
          </p>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-8">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="appearance"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Appearance
              </TabsTrigger>
              <TabsTrigger
                value="notifications"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Notifications
              </TabsTrigger>
              <TabsTrigger
                value="timezone"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Time Zone
              </TabsTrigger>
            </TabsList>

            <div className="mt-4">
              {tab === "appearance" && (
                <div className="flex flex-col gap-6">
                  <AppearanceSettings />
                  <SendModeSettings />
                </div>
              )}
              {tab === "notifications" && <NotificationSettings />}
              {tab === "timezone" && <TimezoneSettings />}
            </div>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
