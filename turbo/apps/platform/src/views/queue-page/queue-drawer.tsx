import { useGet, useSet } from "ccstate-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@vm0/ui";
import {
  queueData$,
  queueDrawerOpen$,
  setQueueDrawerOpen$,
  startQueuePolling$,
} from "../../signals/queue-page/queue-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { QueueOverview } from "./queue-overview.tsx";
import { QueueRunningTable } from "./queue-running-table.tsx";
import { QueueWaitingTable } from "./queue-waiting-table.tsx";

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-muted/20 zero-border h-[132px] animate-pulse" />
      <div className="rounded-xl bg-muted/20 zero-border h-20 animate-pulse" />
      <div className="rounded-xl bg-muted/20 zero-border h-20 animate-pulse" />
    </div>
  );
}

export function QueueDrawer() {
  const open = useGet(queueDrawerOpen$);
  const setOpen = useSet(setQueueDrawerOpen$);
  const data = useGet(queueData$);
  const startPolling = useSet(startQueuePolling$);
  const pageSignal = useGet(pageSignal$);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      detach(startPolling(pageSignal), Reason.DomCallback);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Run Queue</SheetTitle>
          <SheetDescription>
            Organization-wide queue status and running tasks.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 mt-2">
          {!data ? (
            <DrawerSkeleton />
          ) : (
            <>
              <QueueOverview data={data} />
              <QueueRunningTable tasks={data.runningTasks} />
              <QueueWaitingTable
                queue={data.queue}
                estimatedTimePerRun={data.estimatedTimePerRun}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
