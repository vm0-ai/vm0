import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { Switch } from "@okouai/ui/components/ui/switch";
import { Newspaper } from "lucide-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  userPreferences$,
  updateUserPreference$,
} from "../../../../signals/zero-page/settings/user-preferences.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";
import { SettingsSectionHeading } from "./settings-section-heading.tsx";

export function WeeklyProductUpdateSettings() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const preferences = useLastResolved(userPreferences$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateUserPreference$,
  );
  const pageSignal = useGet(pageSignal$);

  const handleChange = onDomEventFn(async (checked: boolean) => {
    await updatePreference({ weeklyProductUpdateEnabled: checked }, pageSignal);
  });

  // Rollout entry point: the setting only appears for orgs (or users) with the
  // weeklyProductUpdate feature switch enabled.
  if (!(features?.[FeatureSwitchKey.WeeklyProductUpdate] ?? false)) {
    return null;
  }

  if (!preferences) {
    return <Skeleton className="h-[76px] w-full rounded-xl" />;
  }

  return (
    <section className="flex flex-col gap-3">
      <SettingsSectionHeading
        title={t(($) => {
          return $.settings.preferences.updates.sectionTitle;
        })}
      />
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Newspaper size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.preferences.weeklyProductUpdate.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.weeklyProductUpdate.description;
              })}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Switch
            checked={preferences.weeklyProductUpdateEnabled}
            disabled={updateLoadable.state === "loading"}
            onCheckedChange={handleChange}
          />
        </div>
      </div>
    </section>
  );
}
