import { useGet, useLastResolved, useSet } from "ccstate-react";
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
  const preferences = useLastResolved(userPreferences$);
  const updatePreference = useSet(updateUserPreference$);

  const loading = useGet(timezoneSaving$);
  const setLoading = useSet(setTimezoneSaving$);

  const handleChange = (value: string) => {
    setLoading(true);
    updatePreference({ timezone: value })
      .finally(() => setLoading(false))
      .catch(() => toast.error("Failed to update timezone"));
  };

  if (!preferences) {
    return <Skeleton className="h-[76px] w-full rounded-xl" />;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Sets the TZ environment variable for your agent sandbox at runtime.
      </p>
      <div
        className="flex items-center gap-4 bg-card p-4 rounded-xl"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
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
            value={preferences.timezone ?? "UTC"}
            onValueChange={handleChange}
            disabled={loading}
          >
            <SelectTrigger className="zero-btn-morandi">
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
