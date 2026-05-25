import { useGet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconClock, IconLoader2 } from "@tabler/icons-react";
import {
  userPreferences$,
  updateUserPreference$,
} from "../../../../signals/zero-page/settings/user-preferences.ts";
import {
  COMMON_TIMEZONES,
  getTimezoneLabel,
} from "../../../../signals/zero-page/cron.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";

export function TimezoneSettings() {
  const preferences = useLastResolved(userPreferences$);
  const [tzLoadable, updatePreference] = useLoadableSet(updateUserPreference$);
  const pageSignal = useGet(pageSignal$);

  const loading = tzLoadable.state === "loading";

  const handleChange = onDomEventFn(async (value: string) => {
    await updatePreference({ timezone: value }, pageSignal);
  });

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
              {timezoneOptions.map((tz) => {
                return (
                  <SelectItem key={tz} value={tz}>
                    {getTimezoneLabel(tz)}
                  </SelectItem>
                );
              })}
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
