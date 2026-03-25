import { useGet, useSet, useLoadable } from "ccstate-react";
import { Card, CardContent } from "@vm0/ui";
import { ZeroScheduleCard, type ScheduleEntry } from "./zero-schedule-card.tsx";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import {
  scheduleTabSaving$,
  setScheduleTabSaving$,
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";

interface ZeroScheduleTabProps {
  agentName: string;
  entries: ScheduleEntry[];
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

export function ZeroScheduleTab({
  agentName,
  entries,
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
        title={`${agentName}'s scheduled tasks`}
        subtitle={`Tasks you've scheduled with ${agentName} to run automatically.`}
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
