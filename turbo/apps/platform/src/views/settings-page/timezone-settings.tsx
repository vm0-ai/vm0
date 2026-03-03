import { useLastResolved, useSet } from "ccstate-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconClock } from "@tabler/icons-react";
import {
  notificationPreferences$,
  updateNotificationPreference$,
} from "../../signals/settings-page/notification-settings.ts";
import { detach, Reason } from "../../signals/utils.ts";

function getCommonTimezones() {
  return [
    { value: "UTC", label: "UTC (Coordinated Universal Time)" },
    { value: "America/New_York", label: "Eastern Time (ET)" },
    { value: "America/Chicago", label: "Central Time (CT)" },
    { value: "America/Denver", label: "Mountain Time (MT)" },
    { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
    { value: "America/Anchorage", label: "Alaska Time (AKT)" },
    { value: "Pacific/Honolulu", label: "Hawaii Time (HST)" },
    { value: "Europe/London", label: "London (GMT/BST)" },
    { value: "Europe/Paris", label: "Central European Time (CET)" },
    { value: "Europe/Helsinki", label: "Eastern European Time (EET)" },
    { value: "Asia/Dubai", label: "Gulf Standard Time (GST)" },
    { value: "Asia/Shanghai", label: "China Standard Time (CST)" },
    { value: "Asia/Tokyo", label: "Japan Standard Time (JST)" },
    { value: "Asia/Hong_Kong", label: "Hong Kong Time (HKT)" },
    { value: "Asia/Singapore", label: "Singapore Time (SGT)" },
    { value: "Australia/Sydney", label: "Australian Eastern Time (AET)" },
    { value: "Pacific/Auckland", label: "New Zealand Time (NZST)" },
  ];
}

export function TimezoneSettings() {
  const preferences = useLastResolved(notificationPreferences$);
  const updatePreference = useSet(updateNotificationPreference$);

  if (!preferences) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-5 w-32 rounded" />
          <Skeleton className="h-4 w-80 rounded" />
        </div>
        <Skeleton className="h-[76px] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">Time Zone</h3>
        <p className="text-sm text-muted-foreground">
          Sets the TZ environment variable for your agent sandbox at runtime.
        </p>
      </div>

      <div className="flex items-center gap-4 border border-border bg-card p-4 rounded-xl">
        <div className="shrink-0">
          <div className="flex h-7 w-7 items-center justify-center">
            <IconClock size={28} stroke={1.5} className="text-foreground" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Time zone</div>
          <div className="text-sm text-muted-foreground">
            Your agents will use this time zone during runs
          </div>
        </div>
        <div className="shrink-0 w-64">
          <Select
            value={preferences.timezone ?? "UTC"}
            onValueChange={(value) =>
              detach(updatePreference({ timezone: value }), Reason.DomCallback)
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {getCommonTimezones().map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
