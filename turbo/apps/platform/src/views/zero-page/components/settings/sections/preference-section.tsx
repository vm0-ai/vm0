import { useGet, useSet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
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
import { SettingsSectionHeading } from "../settings-section-heading.tsx";
import { AccountSection } from "./account-section.tsx";

const THEME_OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  icon: typeof IconSun;
}[] = [
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
  { value: "system", label: "System", icon: IconDeviceDesktop },
];

function AppearanceBlock() {
  const prefLoadable = useLoadable(themePreference$);
  const current =
    prefLoadable.state === "hasData" ? prefLoadable.data : "system";
  const setTheme = useSet(setTheme$);

  return (
    <div className="flex flex-col gap-3">
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
          <div className="text-sm font-medium text-foreground">Theme</div>
          <div className="text-sm text-muted-foreground">
            Your preferred color scheme
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const isActive = current === value;
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

const SEND_OPTIONS: readonly { value: SendMode; label: string }[] = [
  { value: "enter", label: "Enter" },
  { value: "cmd-enter", label: "⌘ Enter" },
];

function EnterBlock() {
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
            Send message with
          </div>
          <div className="text-sm text-muted-foreground">
            {effective === "enter"
              ? "Press Enter to send, Shift+Enter for new line"
              : "Press ⌘/Ctrl+Enter to send, Enter for new line"}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {SEND_OPTIONS.map(({ value, label }) => {
            const isActive =
              saving === value ? true : saving === null && current === value;
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
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SettingsSectionHeading title="Account & Security" />
        <AccountSection />
      </section>

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title="Appearance"
          description="Choose how the interface looks."
        />
        <AppearanceBlock />
      </section>

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title="Enter"
          description="Choose how to send messages in chat."
        />
        <EnterBlock />
      </section>

      <section className="flex flex-col gap-3">
        <SettingsSectionHeading
          title="Time Zone"
          description="Times shown to you and used for scheduled work."
        />
        <TimezoneSettings />
      </section>
    </div>
  );
}
