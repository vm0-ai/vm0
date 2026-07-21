import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Switch } from "@vm0/ui/components/ui/switch";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconSunrise } from "@tabler/icons-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  userPreferences$,
  updateUserPreference$,
} from "../../../../signals/zero-page/settings/user-preferences.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";

export function MorningBriefSettings() {
  const features = useLastResolved(featureSwitch$);
  const preferences = useLastResolved(userPreferences$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateUserPreference$,
  );
  const pageSignal = useGet(pageSignal$);

  const loading = updateLoadable.state === "loading";

  const handleChange = onDomEventFn(async (checked: boolean) => {
    await updatePreference({ morningBriefEnabled: checked }, pageSignal);
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
      </div>
      <div className="shrink-0">
        <Switch
          checked={preferences.morningBriefEnabled}
          disabled={loading}
          onCheckedChange={handleChange}
        />
      </div>
    </div>
  );
}
