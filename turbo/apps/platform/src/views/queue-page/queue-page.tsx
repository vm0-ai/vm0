import { useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import { queueData$ } from "../../signals/queue-page/queue-signals.ts";
import { QueueOverview } from "./queue-overview.tsx";
import { QueueRunningTable } from "./queue-running-table.tsx";
import { QueueWaitingTable } from "./queue-waiting-table.tsx";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

function QueueSkeleton() {
  return (
    <div className="flex flex-col gap-6 px-4 sm:px-6 mb-8">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <Skeleton className="h-48 rounded-lg" />
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}

export function QueuePage() {
  const data = useGet(queueData$);

  return (
    <AppShell
      breadcrumb={["Queue"]}
      title="Run Queue"
      subtitle="View organization-wide queue status and running tasks."
      contentClassName="mx-auto w-full max-w-[1200px]"
    >
      {!data ? (
        <QueueSkeleton />
      ) : (
        <div className="flex flex-col gap-6 px-4 sm:px-6 mb-8">
          <QueueOverview data={data} />
          <QueueRunningTable tasks={data.runningTasks} />
          <QueueWaitingTable
            queue={data.queue}
            estimatedTimePerRun={data.estimatedTimePerRun}
          />
        </div>
      )}
    </AppShell>
  );
}
