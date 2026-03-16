import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconPalette,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { cn } from "@vm0/ui";
import { NotificationSettings } from "../settings-page/notification-settings.tsx";
import { TimezoneSettings } from "../settings-page/timezone-settings.tsx";
import {
  themePreference$,
  setTheme$,
  type ThemePreference,
} from "../../signals/theme.ts";

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
              size={28}
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
              {tab === "appearance" && <AppearanceSettings />}
              {tab === "notifications" && <NotificationSettings />}
              {tab === "timezone" && <TimezoneSettings />}
            </div>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
