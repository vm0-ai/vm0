import { useGet, useLastResolved, useSet } from "ccstate-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { toast } from "@vm0/ui/components/ui/sonner";
import { IconClock, IconLoader2 } from "@tabler/icons-react";
import {
  userPreferences$,
  updateUserPreference$,
} from "../../../../signals/zero-page/settings/user-preferences.ts";
import {
  timezoneSaving$,
  setTimezoneSaving$,
} from "../../../../signals/zero-page/settings/preferences-page.ts";
import {
  COMMON_TIMEZONES,
  getTimezoneLabel,
} from "../../../../signals/zero-page/cron.ts";

export function TimezoneSettings() {
  const preferences = useLastResolved(userPreferences$);
  const updatePreference = useSet(updateUserPreference$);
  const pageSignal = useGet(pageSignal$);

  const loading = useGet(timezoneSaving$);
  const setLoading = useSet(setTimezoneSaving$);

  const handleChange = (value: string) => {
    setLoading(true);
    updatePreference({ timezone: value }, pageSignal)
      .finally(() => setLoading(false))
      .catch(() => toast.error("Failed to update timezone"));
  };

  if (!preferences) {
    return <Skeleton className="h-[76px] w-full rounded-xl" />;
  }

  const currentTimezone =
    preferences.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOptions = (COMMON_TIMEZONES as readonly string[]).includes(
    currentTimezone,
  )
    ? COMMON_TIMEZONES
    : [currentTimezone, ...COMMON_TIMEZONES];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Used to schedule tasks and send notifications at the right time.
      </p>
      <div className="flex items-center gap-4 bg-card p-4 rounded-xl zero-border">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconClock
              size={22}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Time zone</div>
          <div className="text-sm text-muted-foreground">
            Your agents will use this time zone during runs
          </div>
        </div>
        <div className="relative shrink-0 w-64">
          <Select
            value={currentTimezone}
            onValueChange={handleChange}
            disabled={loading}
          >
            <SelectTrigger className="zero-btn-morandi">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {getTimezoneLabel(tz)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-end pr-8">
              <IconLoader2
                size={16}
                className="animate-spin text-muted-foreground"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
