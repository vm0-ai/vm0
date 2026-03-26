import { useGet, useSet, useLoadable } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconPalette,
  IconKeyboard,
  IconLoader2,
  IconUpload,
  IconCheck,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { cn } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { TimezoneSettings } from "./components/settings/timezone-settings.tsx";
import {
  themePreference$,
  setTheme$,
  type ThemePreference,
} from "../../signals/theme.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { SendMode } from "@vm0/core";
import {
  preferencesTab$,
  setPreferencesTab$,
  sendModeSaving$,
  updateSendMode$,
  avatarSaving$,
  updateAvatar$,
} from "../../signals/zero-page/settings/preferences-page.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { user$ } from "../../signals/auth.ts";
import { ZERO_AVATARS } from "./zero-avatars.ts";
import { fetch$ } from "../../signals/fetch.ts";

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
  const saving = useGet(sendModeSaving$);
  const saveSendMode = useSet(updateSendMode$);
  const pageSignal = useGet(pageSignal$);

  const handleChange = (value: SendMode) => {
    detach(saveSendMode(value, pageSignal), Reason.DomCallback);
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
            {(saving ?? current) === "enter"
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

/** Resolve a preset avatar identifier to its bundled image source. */
function getPresetAvatarSrc(id: string): string | undefined {
  const index = Number(id.replace("avatar_", ""));
  return ZERO_AVATARS[index];
}

function getPresetAvatars(): { id: string; src: string }[] {
  return ZERO_AVATARS.map((src, i) => ({ id: `avatar_${i}`, src }));
}

function resolveAvatarSrc(avatarUrl: string | null): string | null {
  if (!avatarUrl) {
    return null;
  }
  const presetSrc = getPresetAvatarSrc(avatarUrl);
  if (presetSrc) {
    return presetSrc;
  }
  return avatarUrl;
}

function AvatarSettings() {
  const pageSignal = useGet(pageSignal$);
  const saving = useGet(avatarSaving$);
  const saveAvatar = useSet(updateAvatar$);
  const prefsLoadable = useLoadable(userPreferences$);
  const userLoadable = useLoadable(user$);
  const fetchFn = useGet(fetch$);

  const currentAvatarUrl =
    prefsLoadable.state === "hasData" ? prefsLoadable.data.avatarUrl : null;

  const userName =
    userLoadable.state === "hasData"
      ? (userLoadable.data?.fullName ?? "User")
      : "User";
  const userInitial = userName.charAt(0).toUpperCase();

  const resolvedSrc = resolveAvatarSrc(currentAvatarUrl);

  const handleSelect = (avatarId: string) => {
    if (saving) {
      return;
    }
    detach(saveAvatar(avatarId, pageSignal), Reason.DomCallback);
  };

  const handleUpload = async (file: File) => {
    if (saving) {
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetchFn("/api/zero/uploads", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      toast.error("Failed to upload avatar");
      return;
    }
    const data = (await res.json()) as { url: string };
    detach(saveAvatar(data.url, pageSignal), Reason.DomCallback);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      detach(handleUpload(file), Reason.DomCallback);
    }
    e.target.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Choose a profile avatar or upload your own.
      </p>

      {/* Current avatar preview */}
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 shrink-0 rounded-xl overflow-hidden">
          {resolvedSrc ? (
            <img
              src={resolvedSrc}
              alt={userName}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full rounded-xl bg-orange-200/95 dark:bg-orange-300/80 flex items-center justify-center text-orange-900 dark:text-orange-950 text-xl font-medium">
              {userInitial}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{userName}</div>
          <div className="text-sm text-muted-foreground">
            {currentAvatarUrl ? "Custom avatar" : "Default avatar"}
          </div>
        </div>
        {saving && (
          <IconLoader2
            size={16}
            className="animate-spin text-muted-foreground"
          />
        )}
      </div>

      {/* Preset avatars + upload */}
      <div className="flex flex-wrap gap-3">
        {getPresetAvatars().map(({ id, src }) => {
          const isSelected = currentAvatarUrl === id;
          return (
            <button
              key={id}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(id)}
              className={cn(
                "relative h-14 w-14 rounded-xl overflow-hidden ring-2 ring-offset-2 ring-offset-background transition-all duration-200 focus:outline-none focus-visible:ring-primary",
                isSelected
                  ? "ring-primary"
                  : "ring-transparent hover:ring-muted-foreground/30",
                saving && "opacity-60 cursor-not-allowed",
              )}
            >
              <img src={src} alt={id} className="h-full w-full object-cover" />
              {isSelected && (
                <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                  <IconCheck size={18} className="text-primary" stroke={2.5} />
                </div>
              )}
            </button>
          );
        })}

        {/* Upload button */}
        <label
          className={cn(
            "h-14 w-14 rounded-xl flex items-center justify-center transition-all duration-200 cursor-pointer focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
            "zero-chip text-muted-foreground hover:text-foreground",
            saving && "opacity-60 pointer-events-none",
          )}
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          <IconUpload size={18} stroke={1.5} />
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>
      </div>

      {/* Remove avatar */}
      {currentAvatarUrl && (
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            detach(saveAvatar(null, pageSignal), Reason.DomCallback)
          }
          className="text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
        >
          Remove avatar
        </button>
      )}
    </div>
  );
}

export function ZeroPreferencesPage() {
  const tab = useGet(preferencesTab$);
  const setTab = useSet(setPreferencesTab$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Preferences
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your profile, appearance and runtime preferences
          </p>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-8">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="profile"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Profile
              </TabsTrigger>
              <TabsTrigger
                value="appearance"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Appearance
              </TabsTrigger>
              <TabsTrigger
                value="timezone"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Time Zone
              </TabsTrigger>
            </TabsList>

            <div className="mt-4">
              {tab === "profile" && <AvatarSettings />}
              {tab === "appearance" && (
                <div className="flex flex-col gap-6">
                  <AppearanceSettings />
                  <SendModeSettings />
                </div>
              )}
              {tab === "timezone" && <TimezoneSettings />}
            </div>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
