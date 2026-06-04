import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import {
  IconCheck,
  IconLoader2,
  IconAlertTriangle,
  IconMessagePlus,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  allOrgSchedulesLoaded$,
  legacySchedulesNeedingChatThread$,
  migrationStatus$,
  migrationRunning$,
  migrateAllLegacySchedules$,
  type LegacyScheduleEntry,
  type MigrationStatus,
} from "../../signals/zero-page/zero-schedule.ts";
import {
  migrateDialogDismissed$,
  setMigrateDialogDismissed$,
} from "../../signals/schedule-page/schedule-page-ui.ts";

function StatusIcon({ status }: { status: MigrationStatus | undefined }) {
  if (status === "migrating") {
    return (
      <IconLoader2
        size={16}
        className="shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (status === "done") {
    return <IconCheck size={16} className="shrink-0 text-emerald-500" />;
  }
  if (status === "error") {
    return <IconAlertTriangle size={16} className="shrink-0 text-amber-500" />;
  }
  return <span className="size-4 shrink-0" aria-hidden />;
}

function MigrateScheduleRow({
  schedule,
  status,
}: {
  schedule: LegacyScheduleEntry;
  status: MigrationStatus | undefined;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2">
      <StatusIcon status={status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {schedule.displayName ?? schedule.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {schedule.time} · {schedule.prompt}
        </p>
      </div>
    </li>
  );
}

export function MigrateSchedulesDialogContainer() {
  const features = useLastResolved(featureSwitch$);
  const chatEnabled = features?.[FeatureSwitchKey.ScheduledChat] ?? false;

  const loaded = useGet(allOrgSchedulesLoaded$);
  const legacyLoadable = useLastLoadable(legacySchedulesNeedingChatThread$);
  const legacy: LegacyScheduleEntry[] =
    legacyLoadable.state === "hasData" ? legacyLoadable.data : [];

  const status = useGet(migrationStatus$);
  const running = useGet(migrationRunning$);
  const dismissed = useGet(migrateDialogDismissed$);
  const setDismissed = useSet(setMigrateDialogDismissed$);
  const migrateAll = useSet(migrateAllLegacySchedules$);
  const pageSignal = useGet(pageSignal$);

  // Auto-surface on entry when chat mode is on and legacy schedules remain.
  // Stay open while a migration is running so progress stays visible even as
  // the list drains.
  const open =
    chatEnabled && loaded && !dismissed && (running || legacy.length > 0);

  const allDone =
    legacy.length > 0 &&
    legacy.every((s) => {
      return status.get(s.id) === "done";
    });

  const close = () => {
    if (running) {
      return;
    }
    setDismissed(true);
  };

  const startMigration = () => {
    detach(migrateAll(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Migrate schedules to chat</DialogTitle>
          <DialogDescription>
            {legacy.length} schedule(s) were created before chat was available
            and have no chat thread yet. Migrate them to give each its own chat
            thread.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex max-h-[18rem] flex-col gap-2 overflow-y-auto py-1">
          {legacy.map((s) => {
            return (
              <MigrateScheduleRow
                key={s.id}
                schedule={s}
                status={status.get(s.id)}
              />
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={close}>
            {allDone ? "Close" : "Not now"}
          </Button>
          <Button className="gap-2" disabled={running} onClick={startMigration}>
            {running ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconMessagePlus size={14} stroke={2} />
            )}
            {running ? "Migrating…" : "Migrate to chat thread"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
