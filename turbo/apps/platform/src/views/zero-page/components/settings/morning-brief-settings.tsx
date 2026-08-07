import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
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
function formatNextRun(
  nextRunAt: string | null,
  timezone: string | null,
  locale: string,
): string | null {
  if (!nextRunAt) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(nextRunAt));
}

export function MorningBriefSettings() {
  const { i18n, t } = useTranslation();
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
  const nextRun = preferences
    ? formatNextRun(
        preferences.morningBriefNextRunAt,
        preferences.timezone,
        i18n.resolvedLanguage ?? i18n.language,
      )
    : null;

  const handleChange = onDomEventFn(async (checked: boolean) => {
    await updatePreference({ morningBriefEnabled: checked }, pageSignal);
  });

  const handleSendNow = onDomEventFn(async () => {
    await triggerBrief(pageSignal);
    toast.success(
      t(($) => {
        return $.settings.preferences.morningBrief.triggeredToast;
      }),
    );
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
    <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
      <div className="flex flex-1 items-center gap-4 min-w-0">
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
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.morningBrief.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.morningBrief.description;
            })}
          </div>
          {preferences.morningBriefEnabled && (
            <div className="text-xs text-muted-foreground">
              {nextRun === null
                ? t(($) => {
                    return $.settings.preferences.morningBrief.notScheduled;
                  })
                : preferences.timezone
                  ? t(
                      ($) => {
                        return $.settings.preferences.morningBrief
                          .nextEmailInTimezone;
                      },
                      {
                        date: nextRun,
                        timezone: preferences.timezone,
                      },
                    )
                  : t(
                      ($) => {
                        return $.settings.preferences.morningBrief.nextEmail;
                      },
                      {
                        date: nextRun,
                      },
                    )}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {manualEnabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={triggering}
            onClick={handleSendNow}
          >
            {triggering
              ? t(($) => {
                  return $.settings.preferences.morningBrief.sending;
                })
              : t(($) => {
                  return $.settings.preferences.morningBrief.sendNow;
                })}
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
