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
import { rootSignal$ } from "../../signals/root-signal.ts";
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
import { pathname$ } from "../../signals/route.ts";

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
  const pathname = useGet(pathname$);
  const onScheduleRoute =
    pathname === "/schedules" || pathname.startsWith("/schedules/");
  const features = useLastResolved(featureSwitch$);
  const chatEnabled = features?.[FeatureSwitchKey.ScheduledChat] ?? false;

  const loaded = useGet(allOrgSchedulesLoaded$);
  const legacyLoadable = useLastLoadable(legacySchedulesNeedingChatThread$);
  const legacy: LegacyScheduleEntry[] =
    legacyLoadable.state === "hasData" ? legacyLoadable.data : [];

  const status = useGet(migrationStatus$);
  const running = useGet(migrationRunning$);
  const migrateAll = useSet(migrateAllLegacySchedules$);
  const rootSignal = useGet(rootSignal$);

  // Auto-surface on schedule routes when chat mode is on and legacy schedules remain.
  // Stay open while a migration is running so progress stays visible even as
  // the list drains.
  const open =
    onScheduleRoute && chatEnabled && loaded && (running || legacy.length > 0);

  const scheduleCountLabel =
    legacy.length === 1 ? "1 schedule was" : `${legacy.length} schedules were`;
  const hasErrors = legacy.some((s) => {
    return status.get(s.id) === "error";
  });

  const startMigration = () => {
    detach(migrateAll(rootSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={() => {
        // This migration is required once the org has schedule chat enabled.
      }}
    >
      <DialogContent
        className="[&>button[aria-label=Close]:last-child]:hidden"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Migrate schedules to chat</DialogTitle>
          <DialogDescription>
            {scheduleCountLabel} created before chat was available and have no
            chat thread yet. Migrate them to give each its own chat thread.
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
          <Button className="gap-2" disabled={running} onClick={startMigration}>
            {running ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconMessagePlus size={14} stroke={2} />
            )}
            {running
              ? "Migrating..."
              : hasErrors
                ? "Retry migration"
                : "Migrate to chat thread"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
