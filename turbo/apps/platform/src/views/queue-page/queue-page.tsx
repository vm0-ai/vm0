import { useGet } from "ccstate-react";
import { queueData$ } from "../../signals/queue-page/queue-signals.ts";
import { QueueOverview } from "./queue-overview.tsx";
import { QueueRunningTable } from "./queue-running-table.tsx";
import { QueueWaitingTable } from "./queue-waiting-table.tsx";

function QueueSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="zero-card p-4 h-24 animate-pulse bg-muted/20" />
        <div className="zero-card p-4 h-24 animate-pulse bg-muted/20" />
        <div className="zero-card p-4 h-24 animate-pulse bg-muted/20" />
      </div>
      <div className="zero-card h-48 animate-pulse bg-muted/20" />
      <div className="zero-card h-48 animate-pulse bg-muted/20" />
    </div>
  );
}

export function QueuePage() {
  const data = useGet(queueData$);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Run Queue
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Organization-wide queue status and running tasks.
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {!data ? (
            <QueueSkeleton />
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
      </main>
    </div>
  );
}
