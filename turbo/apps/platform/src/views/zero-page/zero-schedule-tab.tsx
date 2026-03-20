/* eslint-disable ccstate/no-use-ccstate-in-views */
import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { Card, CardContent } from "@vm0/ui";
import { ZeroScheduleCard, type ScheduleEntry } from "./zero-schedule-card.tsx";
import { notificationPreferences$ } from "../../signals/zero-page/settings/notification-settings.ts";

interface ZeroScheduleSaveParams {
  prompt: string;
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  intervalSeconds: number;
  dayOfWeek?: string;
  dayOfMonth?: string;
  editName?: string;
}

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
}

export function ZeroScheduleTab({
  agentName,
  entries,
  scheduleError,
  onSave,
  onDelete,
  onToggleEnabled,
}: ZeroScheduleTabProps) {
  const prefsLoadable = useLoadable(notificationPreferences$);
  const userTimezone =
    prefsLoadable.state === "hasData" ? prefsLoadable.data.timezone : null;
  const saving$ = useCCState(false);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);

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
        saving={saving}
        defaultTimezone={userTimezone ?? undefined}
      />
    </div>
  );
}
