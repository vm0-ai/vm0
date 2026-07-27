import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { Button } from "@vm0/ui/components/ui/button";
import { toast } from "@vm0/ui/components/ui/sonner";
import { Switch } from "@vm0/ui/components/ui/switch";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconSunrise } from "@tabler/icons-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  userPreferences$,
  updateUserPreference$,
  triggerMorningBrief$,
} from "../../../../signals/zero-page/settings/user-preferences.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";

/**
 * Human-readable next scheduled send, rendered in the member's preference
 * timezone so the shown time matches the 7:00 local product promise.
 */
function nextRunLabel(
  nextRunAt: string | null,
  timezone: string | null,
): string {
  if (!nextRunAt) {
    return "Next email: not scheduled yet — turn the switch off and on to reschedule";
  }
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(nextRunAt));
  return timezone
    ? `Next email: ${formatted} (${timezone})`
    : `Next email: ${formatted}`;
}

export function MorningBriefSettings() {
  const features = useLastResolved(featureSwitch$);
  const preferences = useLastResolved(userPreferences$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateUserPreference$,
  );
  const [triggerLoadable, triggerBrief] = useLoadableSet(triggerMorningBrief$);
  const pageSignal = useGet(pageSignal$);

  const loading = updateLoadable.state === "loading";
  const triggering = triggerLoadable.state === "loading";
  const manualEnabled =
    features?.[FeatureSwitchKey.ManualMorningBrief] ?? false;

  const handleChange = onDomEventFn(async (checked: boolean) => {
    await updatePreference({ morningBriefEnabled: checked }, pageSignal);
  });

  const handleSendNow = onDomEventFn(async () => {
    await triggerBrief(pageSignal);
    toast.success("Morning Brief triggered, the email arrives shortly");
  });

  // Rollout entry point: the setting only appears for orgs (or users) with
  // the morningBrief feature switch enabled.
  if (!(features?.[FeatureSwitchKey.MorningBrief] ?? false)) {
    return null;
  }

  if (!preferences) {
    return <Skeleton className="h-[76px] w-full rounded-xl" />;
  }

  return (
    <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
      <div className="shrink-0">
        <div className="flex h-7 w-7 items-center justify-center">
          <IconSunrise
            size={22}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">Morning Brief</div>
        <div className="text-sm text-muted-foreground">
          A daily 7:00 AM email with your schedule, action items, and updates
          from connected GitHub, Gmail, and Google Calendar
        </div>
        {preferences.morningBriefEnabled && (
          <div className="text-xs text-muted-foreground">
            {nextRunLabel(
              preferences.morningBriefNextRunAt,
              preferences.timezone,
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {manualEnabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={triggering}
            onClick={handleSendNow}
          >
            {triggering ? "Sending…" : "Send now"}
          </Button>
        )}
        <Switch
          checked={preferences.morningBriefEnabled}
          disabled={loading}
          onCheckedChange={handleChange}
        />
      </div>
    </div>
  );
}
