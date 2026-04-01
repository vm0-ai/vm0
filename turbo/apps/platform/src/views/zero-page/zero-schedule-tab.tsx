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
    <Card className="zero-card">
      <CardContent className="p-0 flex flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 px-5 pt-5 pb-4 border-b border-border/50">
          <div className="min-w-0 flex flex-col gap-1.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Skeleton className="h-9 w-[120px] rounded-lg" />
            <Skeleton className="h-9 w-[140px] rounded-lg" />
          </div>
        </header>
        {/* Mobile skeleton */}
        <div className="sm:hidden pb-2">
          {SKELETON_KEYS.map((key) => {
            return (
              <div
                key={key}
                className="flex items-center gap-2 px-5 py-3 border-b border-border/50 last:border-0"
              >
                <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-full max-w-xs" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <Skeleton className="h-5 w-9 rounded-full" />
                  <Skeleton className="h-8 w-8 rounded-lg" />
                </div>
              </div>
            );
          })}
        </div>
        {/* Desktop skeleton */}
        <div className="hidden sm:block w-full overflow-x-auto pb-2">
          <table className="w-full text-sm border-collapse [&_tr>:first-child]:pl-5 [&_tr>:last-child]:pr-5">
            <thead>
              <tr className="border-b border-border/40 bg-card text-left text-sm text-muted-foreground">
                <th
                  className="py-3 pr-4 min-w-0 align-middle font-medium"
                  scope="col"
                >
                  Instruction
                </th>
                <th
                  className="py-3 px-2 min-w-[6.5rem] max-w-[9rem] align-middle font-medium"
                  scope="col"
                >
                  Schedule at
                </th>
                <th
                  className="py-3 px-3 w-16 text-center align-middle font-medium"
                  scope="col"
                >
                  Status
                </th>
                <th className="w-10 py-3 pl-2 align-middle" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {SKELETON_KEYS.map((key) => {
                return (
                  <tr
                    key={key}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="py-2.5 pr-4 align-middle min-w-0 max-w-[1px]">
                      <Skeleton className="h-4 w-full max-w-md" />
                    </td>
                    <td className="py-2.5 px-2 align-middle min-w-[6.5rem] max-w-[9rem] overflow-hidden">
                      <Skeleton className="h-4 w-full max-w-[8rem] rounded-md" />
                    </td>
                    <td className="py-2.5 px-3 align-middle w-16">
                      <div className="flex justify-center">
                        <Skeleton className="h-5 w-9 rounded-full" />
                      </div>
                    </td>
                    <td className="py-2.5 pl-2 align-middle text-right w-10">
                      <div className="flex justify-end">
                        <Skeleton className="h-8 w-8 rounded-lg" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
      />
    </div>
  );
}
