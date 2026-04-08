import { useGet, useSet, useLoadable } from "ccstate-react";
import { Card, CardContent } from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { ZeroScheduleCard, type ScheduleEntry } from "./zero-schedule-card.tsx";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import {
  scheduleTabSaving$,
  setScheduleTabSaving$,
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";

interface ZeroScheduleTabProps {
  displayName: string;
  entries: ScheduleEntry[];
  loading?: boolean;
  scheduleError?: string | null;
  saveError?: string | null;
  onSave: (params: ZeroScheduleSaveParams) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onToggleEnabled: (params: {
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  onRunNow?: (entry: ScheduleEntry) => Promise<void>;
  onOpenDetails?: (entry: ScheduleEntry) => void;
}

const SKELETON_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4"] as const;

function ScheduleTabSkeleton() {
  return (
    <Card className="zero-card" data-testid="schedule-tab-skeleton">
      <CardContent className="p-0 flex flex-col">
        <div className="flex flex-wrap items-end justify-between gap-4 px-5 pt-5 pb-4 border-b border-border/50">
          <div className="min-w-0 flex flex-col gap-1.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Skeleton className="h-9 w-[120px] rounded-lg" />
            <Skeleton className="h-9 w-[140px] rounded-lg" />
          </div>
        </div>
        <div className="flex flex-col gap-0 pb-2">
          {SKELETON_KEYS.map((key) => {
            return (
              <div
                key={key}
                className="flex items-center gap-3 px-5 py-3 border-b border-border/50 last:border-0"
              >
                <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-full max-w-md" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full shrink-0" />
                <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function ZeroScheduleTab({
  displayName,
  entries,
  loading,
  scheduleError,
  saveError,
  onSave,
  onDelete,
  onToggleEnabled,
  onRunNow,
  onOpenDetails,
}: ZeroScheduleTabProps) {
  const prefsLoadable = useLoadable(userPreferences$);
  const userTimezone =
    prefsLoadable.state === "hasData" ? prefsLoadable.data.timezone : null;
  const saving = useGet(scheduleTabSaving$);
  const setSaving = useSet(setScheduleTabSaving$);

  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <ScheduleTabSkeleton />
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="mx-auto max-w-[900px]">
        <Card className="zero-card">
          <CardContent className="px-6 py-6 text-center">
            <p className="text-sm text-destructive">{scheduleError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSave = async (params: ZeroScheduleSaveParams) => {
    setSaving(true);
    // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove try/finally — use useLoadableSet for loading state
    try {
      await onSave(params);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-[900px]">
      <ZeroScheduleCard
        title={`${displayName}'s scheduled tasks`}
        subtitle={`Tasks you've scheduled with ${displayName} to run automatically.`}
        initialSchedule={entries}
        onSave={handleSave}
        onDelete={onDelete}
        onToggleEnabled={onToggleEnabled}
        onRunNow={onRunNow}
        onOpenDetails={onOpenDetails}
        saving={saving}
        defaultTimezone={userTimezone ?? undefined}
        saveError={saveError}
      />
    </div>
  );
}
