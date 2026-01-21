import { useSet, useLoadable, useGet } from "ccstate-react";
import { AppShell } from "../layout/app-shell.tsx";
import { LogsTable } from "./logs-table.tsx";
import { loadMore$, hasMore$ } from "../../signals/logs-page/logs-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Button } from "@vm0/ui";

export function LogsPage() {
  const hasMoreLoadable = useLoadable(hasMore$);
  const loadMoreFn = useSet(loadMore$);
  const pageSignal = useGet(pageSignal$);

  const handleLoadMore = () => {
    detach(loadMoreFn(pageSignal), Reason.DomCallback);
  };

  const showLoadMore =
    hasMoreLoadable.state === "hasData" && hasMoreLoadable.data;

  return (
    <AppShell
      breadcrumb={["Logs"]}
      title="Logs"
      subtitle="View all agent runs and execution history."
    >
      <div className="px-8">
        {/* Logs Table */}
        <div className="mt-4">
          <LogsTable />
        </div>

        {/* Load More Button */}
        {showLoadMore && (
          <div className="mt-4 flex justify-center">
            <Button onClick={handleLoadMore} variant="outline">
              Load More
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
